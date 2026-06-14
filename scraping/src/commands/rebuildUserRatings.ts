import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(__dirname, '../../../.env') });

type Options = {
    user?: string;
    dryRun: boolean;
};

function parseOptions(argv: string[]): Options {
    const options: Options = { dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--user') {
            const user = argv[i + 1];
            if (!user) {
                throw new Error('--user requires a username');
            }
            options.user = user;
            i++;
        } else if (arg.startsWith('--user=')) {
            options.user = arg.slice('--user='.length);
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

function printHelp() {
    console.log(`Usage:
  npm run repair:ratings
  npm run repair:ratings -- --user <atcoder_user>
  npm run repair:ratings -- --dry-run

Rebuilds User.algoRating, User.heuristicRating, User.algoAPerf,
User.heuristicAPerf and User.lastContestTime from userRatingChangeEvent
ordered by Contest.endTime.`);
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

async function rebuildUser(prisma: PrismaClient, userId: number, dryRun: boolean) {
    const ratingEvents = await prisma.userRatingChangeEvent.findMany({
        where: {
            userId,
            isRated: true,
        },
        include: {
            contest: {
                select: {
                    endTime: true,
                },
            },
        },
        orderBy: [
            {
                contest: {
                    endTime: 'asc',
                },
            },
            { id: 'asc' },
        ],
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

    const data = {
        algoRating,
        heuristicRating,
        algoAPerf: calculateAPerf(algoInnerPerformances),
        heuristicAPerf: calculateAPerf(heuristicInnerPerformances),
        lastContestTime: ratingEvents.length > 0 ? ratingEvents[ratingEvents.length - 1].contest.endTime : null,
    };

    if (!dryRun) {
        await prisma.user.update({
            where: { id: userId },
            data,
        });
    }

    return data;
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    const prisma = new PrismaClient();
    await prisma.$connect();

    try {
        const where = options.user ? { name: options.user } : {};
        const batchSize = options.user ? 1 : 500;
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
                },
            });
            if (users.length === 0) {
                break;
            }

            for (const user of users) {
                const rebuilt = await rebuildUser(prisma, user.id, options.dryRun);
                processed++;
                if (options.user || processed % 1000 === 0) {
                    console.log(
                        `${options.dryRun ? '[dry-run] ' : ''}rebuilt ${user.name}: algo=${rebuilt.algoRating}, heuristic=${rebuilt.heuristicRating}`,
                    );
                }
            }

            cursor = users[users.length - 1].id;
            if (options.user) {
                break;
            }
        }

        if (options.user && processed === 0) {
            throw new Error(`User not found: ${options.user}`);
        }
        console.log(`${options.dryRun ? '[dry-run] ' : ''}rebuilt ratings for ${processed} user(s).`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
