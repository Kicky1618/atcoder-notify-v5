import { Main } from '..';
import { Database } from '../database';
import { Logger } from '../utils/logger';
import { ScraperContest } from './contests/crawlContest';
import cron from 'node-cron';
import { CrawlAllSubmissions, setTimeoutValue, setWindow } from './submissions/getSubmissions';
import { ScraperContestResult } from './contests/crawlContestResult';
import { nextTick } from 'process';
import { TwitterApi } from 'twitter-api-v2';
import { createCircleGraph } from '../utils/createCircleGraph';
import sharp from 'sharp';
import { rebuildUsersTable } from '../build_db/users';

export namespace AtCoderScraper {
    let sessionId: string | null = null;
    export let logger: Logger;
    let crawlingContestResults = false;

    export async function initAtCoderScraper() {
        logger = Main.getLogger().child('AtCoderScraper');
        logger.info('Initializing AtCoder scraper...');

        // Get session ID from database
        const sessionRow = await Database.getDatabase().config.findUnique({
            where: { key: 'atcoder_session' },
        });
        if (sessionRow) {
            sessionId = encodeURI(sessionRow.value);
            logger.trace('Session ID found and loaded');
        } else {
            logger.fatal('Session ID not found in database');
            throw new Error('Session ID not found in database');
        }

        logger.info('AtCoder scraper initialized successfully');
        logger.info('Starting AtCoder scraper cron jobs...');
        cron.schedule('*/30 * * * * *', runEvery30Seconds, { timezone: 'Asia/Tokyo' });
        cron.schedule('*/1 * * * *', runEveryMinute, { timezone: 'Asia/Tokyo' });
        cron.schedule('0 7 * * *', runDaily, { timezone: 'Asia/Tokyo' });
        logger.info('AtCoder scraper cron jobs started successfully');
        runDaily();
        CrawlAllSubmissionsEvent();
        CrawlContestResults();
    }

    export async function CrawlContestResults(isNull = false) {
        if (crawlingContestResults) return;
        const contests = await Database.getDatabase().contest.findMany({
            where: {
                endTime: {
                    lte: new Date(),
                    // gte: new Date(new Date().setDate(new Date().getDate() - 14)),
                },
                resultPageHash: isNull ? void 0 : null,
            },
            orderBy: { endTime: 'asc' },
        });
        const contestsUnCrawledPDF = await Database.getDatabase().contest.findMany({
            where: {
                endTime: {
                    lte: new Date(),
                },
                crawledPDF: false,
            },
            orderBy: { endTime: 'asc' },
        });
        crawlingContestResults = true;
        const concurrency = 3;
        let idx = 0;
        const workers = Array.from({ length: concurrency }, () =>
            (async () => {
            while (true) {
                const i = idx++;
                if (i >= contests.length) break;
                const contest = contests[i];
                try {
                    await ScraperContestResult.crawlContestResult(contest.id);
                } catch (err: any) {
                    logger.error(err, err.cause?.code, err.cause?.options, `Failed to crawl contest ${contest.id}`);
                }
            }
            })()
        );
        await Promise.all(workers);

        crawlingContestResults = false;
    }
    export async function CrawlAllSubmissionsEvent() {
        logger.info('Crawling all submissions...');
        const contests = await Database.getDatabase().contest.findMany({
            where: {
                endTime: {
                    lte: new Date(),
                },
            },
            orderBy: { endTime: 'asc' },
        });
        for (const contest of contests) {
            await CrawlAllSubmissions(contest.id);
        }
        nextTick(() => {
            logger.info('Crawling all submissions completed.');
            CrawlAllSubmissionsEvent();
        });
    }

    export function getCookie() {
        if (!sessionId) {
            logger.fatal('Session ID is not set. Please initialize the scraper first.');
            throw new Error('Session ID is not set. Please initialize the scraper first.');
        }
        return `REVEL_SESSION=${decodeURI(sessionId)}`;
    }
    function runEvery30Seconds() {
        logger.info('Running every 30 seconds...');
    }
    function runEveryMinute() {
        logger.info('Running every minute...');
        CrawlContestResults();
    }
    async function runDaily() {
        logger.info('Running daily...');
        CrawlContestResults(true);
        ScraperContest.CrawlAllContest();
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);

        const contests = await Database.getDatabase().contest.findMany({
            where: {
                OR: [
                    {
                        startTime: { gte: startOfToday, lte: endOfToday },
                        endTime: { gte: startOfToday, lte: endOfToday },
                    },
                ],
            },
        });
        if (contests.length > 0) {
            setWindow(1);
            setTimeoutValue(1000);
        } else {
            setWindow(1);
            setTimeoutValue(300);
        }

        const linkedUsers = await Database.getDatabase().kickyUser.findMany({
            where: {
                twitterOAuthUsername: {
                    not: null,
                },
                linkedAtCoderUserId: {
                    not: null,
                },
            },
        });
        // JSTで昨日の開始・終了時刻を取得
        const startOfYesterday = new Date();
        startOfYesterday.setHours(0, 0, 0, 0);
        startOfYesterday.setDate(startOfYesterday.getDate() - 1);
        startOfYesterday.setHours(startOfYesterday.getHours() - startOfYesterday.getTimezoneOffset() / 60 + 9);

        const endOfYesterday = new Date();
        endOfYesterday.setHours(23, 59, 59, 999);
        endOfYesterday.setDate(endOfYesterday.getDate() - 1);
        endOfYesterday.setHours(endOfYesterday.getHours() - endOfYesterday.getTimezoneOffset() / 60 + 9);
        let difficulties = await (await fetch('https://kenkoooo.com/atcoder/resources/problem-models.json')).json();
        for (let user of linkedUsers) {
            const submissionCount = await Database.getDatabase().submissions.count({
                where: {
                    datetime: {
                        gte: startOfYesterday,
                        lte: endOfYesterday,
                    },
                    user: { id: user.linkedAtCoderUserId! },
                },
            });
            const atcoderUsername = await Database.getDatabase().user.findUnique({
                where: {
                    id: user.linkedAtCoderUserId!,
                },
            });
            let message = '';
            if (submissionCount == 0) {
                message = `提出数が0って、サボってたんかよ。許せんなぁ`;
            } else if (submissionCount < 4) {
                message = `Streakを続けようという気持ち、忘れるな`;
            } else if (submissionCount <= 10) {
                message = `結構素晴らしいのではないか`;
            } else {
                message = `十分すぎる精進量だ。生活をおろそかにするなよ`;
            }
            let twitterClient = new TwitterApi({
                appKey: process.env.TWITTER_API_KEY!,
                appSecret: process.env.TWITTER_API_KEY_SECRET!,
                accessToken: user.twitterOAuthAccessToken!,
                accessSecret: user.twitterOAuthAccessSecret!,
            });
            let images = [];
            if (submissionCount > 0) {
                let submissions = await Database.getDatabase().submissions.groupBy({
                    where: {
                        datetime: {
                            gte: startOfYesterday,
                            lte: endOfYesterday,
                        },
                        user: { id: user.linkedAtCoderUserId! },
                    },
                    _count: true,
                    by: 'status',
                });
                let data = [];
                for (let i of submissions) {
                    if (i.status == 'AC') {
                        data.push({
                            color: '#5cb85c',
                            data: i._count,
                            label: i.status + '(' + i._count + ')',
                        });
                    } else {
                        data.push({
                            color: '#f0ad4e',
                            data: i._count,
                            label: i.status + '(' + i._count + ')',
                        });
                    }
                }
                let svg = createCircleGraph('提出内訳(結果)', data);
                let png = await sharp(Buffer.from(svg)).png().toBuffer();
                let mediaId = await twitterClient.v2.uploadMedia(png, {
                    media_type: 'image/png',
                });
                images.push(mediaId);
                let submissions2 = await Database.getDatabase().submissions.findMany({
                    where: {
                        datetime: {
                            gte: startOfYesterday,
                            lte: endOfYesterday,
                        },
                        user: { id: user.linkedAtCoderUserId! },
                    },
                    select: {
                        task: true
                    }
                });
                let data2Map: { [key: string]: { count: number; color: string; label: string } } = {};
                for (let i of submissions2) {
                    const problemId = i.task.taskid;
                    const diffObj = difficulties[problemId];
                    let difficulty = 0;
                    if (!diffObj || !diffObj.difficulty) {
                        difficulty = -1;
                    } else {
                        difficulty = mapRating(diffObj.difficulty);
                    }
                    let bucket = Math.floor(difficulty / 400) * 400;
                    let color = getColorByRating(difficulty);
                    let label = `${bucket}~${bucket + 399}`;
                    if (!data2Map[label]) {
                        data2Map[label] = { count: 0, color, label };
                    }
                    data2Map[label].count += 1;
                }
                let data2 = Object.values(data2Map).map((d) => ({
                    color: d.color,
                    data: d.count,
                    label: '',
                }));
                let svg2 = createCircleGraph('提出内訳(diff)', data2);
                let png2 = await sharp(Buffer.from(svg2)).png().toBuffer();
                let mediaId2 = await twitterClient.v2.uploadMedia(png2, {
                    media_type: 'image/png',
                });
                images.push(mediaId2);
            }
            const kyoproClubURL = `https://beta.kyo-pro.club`;
            await twitterClient.v2.tweet(`あんた(${atcoderUsername?.name})の昨日の提出は${submissionCount}件。${message}\n${kyoproClubURL}`, {
                media: { media_ids: images as [string, string] },
            });
        }
    }
}
const COLORS: Array<{ rating: number; color: string; alpha: number }> = [
    { rating: 0, color: '#808080', alpha: 0.15 },
    { rating: 400, color: '#804000', alpha: 0.15 },
    { rating: 800, color: '#008000', alpha: 0.15 },
    { rating: 1200, color: '#00C0C0', alpha: 0.2 },
    { rating: 1600, color: '#0000FF', alpha: 0.1 },
    { rating: 2000, color: '#C0C000', alpha: 0.25 },
    { rating: 2400, color: '#FF8000', alpha: 0.2 },
    { rating: 2800, color: '#FF0000', alpha: 0.1 },
];
COLORS.reverse();
export function getColorByRating(rating: number): string {
    const color = COLORS.find((c) => mapRating(rating) >= c.rating);
    if (color) {
        return color.color;
    }
    return 'black';
}
function mapRating(rating: number) {
    if (rating < 400) {
        return 400 / Math.exp((400 - rating) / 400);
    }
    return rating;
}
