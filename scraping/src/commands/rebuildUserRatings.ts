import { Prisma, PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(__dirname, '../../../.env') });

type Options = {
    user?: string;
    dryRun: boolean;
    nodeMode: boolean;
    batchSize: number;
};

function parseOptions(argv: string[]): Options {
    const options: Options = { dryRun: false, nodeMode: false, batchSize: 1000 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--node') {
            options.nodeMode = true;
        } else if (arg === '--user') {
            const user = argv[i + 1];
            if (!user) {
                throw new Error('--user requires a username');
            }
            options.user = user;
            i++;
        } else if (arg.startsWith('--user=')) {
            options.user = arg.slice('--user='.length);
        } else if (arg === '--batch-size') {
            const batchSize = parseBatchSize(argv[i + 1]);
            options.batchSize = batchSize;
            i++;
        } else if (arg.startsWith('--batch-size=')) {
            options.batchSize = parseBatchSize(arg.slice('--batch-size='.length));
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

function parseBatchSize(value: string | undefined) {
    if (!value) {
        throw new Error('--batch-size requires a positive integer');
    }
    const batchSize = Number(value);
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error(`Invalid --batch-size: ${value}`);
    }
    return batchSize;
}

function printHelp() {
    console.log(`Usage:
  npm run repair:ratings
  npm run repair:ratings -- --user <atcoder_user>
  npm run repair:ratings -- --dry-run
  npm run repair:ratings -- --node
  npm run repair:ratings -- --node --batch-size 500

Synchronizes cached User.algoRating, User.heuristicRating,
User.algoAPerf, User.heuristicAPerf and User.lastContestTime from
rated userRatingChangeEvent rows ordered by Contest.endTime.

By default, full synchronization runs as one SQL UPDATE inside the database.
Use --node only as a compatibility fallback or when --user is specified.
--batch-size controls only Node mode.`);
}

function calculateAPerf(innerPerformances: number[]) {
    if (innerPerformances.length === 0) {
        return null;
    }
    let weightedSum = 0;
    let count = 0;
    for (const performance of [...innerPerformances].reverse()) {
        count += 1;
        weightedSum += performance * 0.9 ** count;
    }
    return weightedSum / (9 * (1 - 0.9 ** count));
}

type UserWithRatings = Prisma.UserGetPayload<{
    select: {
        id: true;
        name: true;
        ratings: {
            where: { isRated: true };
            select: {
                id: true;
                newRating: true;
                InnerPerformance: true;
                isHeuristic: true;
                contest: {
                    select: {
                        endTime: true;
                    };
                };
            };
        };
    };
}>;

function rebuildUserData(user: UserWithRatings) {
    const ratingEvents = [...user.ratings].sort((a, b) => {
        const byEndTime = a.contest.endTime.getTime() - b.contest.endTime.getTime();
        return byEndTime === 0 ? a.id - b.id : byEndTime;
    });
    let algoRating = -1;
    let heuristicRating = -1;
    const algoInnerPerformances: number[] = [];
    const heuristicInnerPerformances: number[] = [];

    for (const event of ratingEvents) {
        if (event.isHeuristic) {
            heuristicRating = event.newRating;
            heuristicInnerPerformances.push(event.InnerPerformance);
        } else {
            algoRating = event.newRating;
            algoInnerPerformances.push(event.InnerPerformance);
        }
    }

    return {
        algoRating,
        heuristicRating,
        algoAPerf: calculateAPerf(algoInnerPerformances),
        heuristicAPerf: calculateAPerf(heuristicInnerPerformances),
        lastContestTime: ratingEvents.length > 0 ? ratingEvents[ratingEvents.length - 1].contest.endTime : null,
    };
}

async function rebuildAllUsersWithSql(prisma: PrismaClient, dryRun: boolean) {
    if (dryRun) {
        const [users, events] = await Promise.all([
            prisma.user.count(),
            prisma.userRatingChangeEvent.count({ where: { isRated: true } }),
        ]);
        console.log(`[dry-run] would rebuild ${users} user(s) from ${events} rated rating event(s) using SQL mode.`);
        return users;
    }

    await prisma.$executeRawUnsafe(`
        UPDATE \`User\` AS u
        LEFT JOIN (
            SELECT
                userId,
                MAX(CASE WHEN isHeuristic = 0 THEN latestRating END) AS algoRating,
                MAX(CASE WHEN isHeuristic = 1 THEN latestRating END) AS heuristicRating,
                MAX(CASE WHEN isHeuristic = 0 THEN aperf END) AS algoAPerf,
                MAX(CASE WHEN isHeuristic = 1 THEN aperf END) AS heuristicAPerf,
                MAX(lastContestTime) AS lastContestTime
            FROM (
                SELECT
                    userId,
                    isHeuristic,
                    MAX(CASE WHEN rnDesc = 1 THEN newRating END) AS latestRating,
                    SUM(InnerPerformance * POW(0.9, totalCount - rnAsc + 1)) / (9 * (1 - POW(0.9, totalCount))) AS aperf,
                    MAX(endTime) AS lastContestTime
                FROM (
                    SELECT
                        r.userId,
                        r.isHeuristic,
                        r.newRating,
                        r.InnerPerformance,
                        c.endTime,
                        ROW_NUMBER() OVER (
                            PARTITION BY r.userId, r.isHeuristic
                            ORDER BY c.endTime ASC, r.id ASC
                        ) AS rnAsc,
                        ROW_NUMBER() OVER (
                            PARTITION BY r.userId, r.isHeuristic
                            ORDER BY c.endTime DESC, r.id DESC
                        ) AS rnDesc,
                        COUNT(*) OVER (
                            PARTITION BY r.userId, r.isHeuristic
                        ) AS totalCount
                    FROM \`userRatingChangeEvent\` AS r
                    INNER JOIN \`Contest\` AS c ON c.id = r.contestId
                    WHERE r.isRated = 1
                ) AS ordered_events
                GROUP BY userId, isHeuristic, totalCount
            ) AS per_kind
            GROUP BY userId
        ) AS stats ON stats.userId = u.id
        SET
            u.algoRating = COALESCE(stats.algoRating, -1),
            u.heuristicRating = COALESCE(stats.heuristicRating, -1),
            u.algoAPerf = stats.algoAPerf,
            u.heuristicAPerf = stats.heuristicAPerf,
            u.lastContestTime = stats.lastContestTime
    `);

    return prisma.user.count();
}

async function rebuildUsersWithNode(prisma: PrismaClient, options: Options) {
    const where = options.user ? { name: options.user } : {};
    const batchSize = options.user ? 1 : options.batchSize;
    let cursor = 0;
    let processed = 0;

    while (true) {
        const users = await prisma.user.findMany({
            where: {
                ...where,
                id: { gt: cursor },
            },
            orderBy: { id: 'asc' },
            take: batchSize,
            select: {
                id: true,
                name: true,
                ratings: {
                    where: { isRated: true },
                    select: {
                        id: true,
                        newRating: true,
                        InnerPerformance: true,
                        isHeuristic: true,
                        contest: {
                            select: {
                                endTime: true,
                            },
                        },
                    },
                },
            },
        });
        if (users.length === 0) {
            break;
        }

        const updates: Prisma.PrismaPromise<unknown>[] = [];
        for (const user of users) {
            const rebuilt = rebuildUserData(user);
            processed++;
            if (!options.dryRun) {
                updates.push(
                    prisma.user.update({
                        where: { id: user.id },
                        data: rebuilt,
                    }),
                );
            }
            if (options.user || processed % 1000 === 0) {
                console.log(
                    `${options.dryRun ? '[dry-run] ' : ''}rebuilt ${user.name}: algo=${rebuilt.algoRating}, heuristic=${rebuilt.heuristicRating}`,
                );
            }
        }
        if (updates.length > 0) {
            await prisma.$transaction(updates);
        }

        cursor = users[users.length - 1].id;
        if (options.user) {
            break;
        }
    }

    if (options.user && processed === 0) {
        throw new Error(`User not found: ${options.user}`);
    }
    return processed;
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    const prisma = new PrismaClient();
    await prisma.$connect();

    try {
        const startedAt = Date.now();
        const useSqlMode = !options.user && !options.nodeMode;
        const processed = useSqlMode
            ? await rebuildAllUsersWithSql(prisma, options.dryRun)
            : await rebuildUsersWithNode(prisma, options);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(
            `${options.dryRun ? '[dry-run] ' : ''}rebuilt ratings for ${processed} user(s) in ${elapsed}s using ${useSqlMode ? 'SQL' : 'Node'} mode.`,
        );
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
