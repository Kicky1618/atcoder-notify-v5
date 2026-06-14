import * as cheerio from 'cheerio';
import { Element } from 'domhandler';
import { Proxy } from '../../proxy/proxy';
import { AtCoderScraper } from '../atcoderScraper';
import { contestType } from '@prisma/client';
import { Config } from '../../config/config';
import { Database } from '../../database';
import puppeteer from 'puppeteer';
import path from 'path';
import { existsSync } from 'fs';
import { ScrapingState } from '../scrapingState';

export namespace ScraperContest {
    export async function CrawlAllContest() {
        await ScrapingState.run('contests', undefined, async () => {
            const futureAndCurrentContestsURL = `https://atcoder.jp/contests/?lang=ja`;
            const response = await Proxy.get(futureAndCurrentContestsURL, AtCoderScraper.getCookie());
            const $ = cheerio.load(response.data);
            const contestList = $('#contest-table-upcoming table tbody tr,#contest-table-action table tbody tr');
            const contestListArray = contestList.toArray();
            await Promise.all(contestListArray.map(analyzeContest));
            await getPastContests();
        });
    }
    async function getPastContests() {
        let maxPage = 1;
        for (let page = 1; page <= maxPage; page++) {
            const currentPage = await getPastContestPage(page);
            if (currentPage > maxPage) {
                maxPage = currentPage;
            }
        }
    }
    async function getPastContestPage(page: number) {
        const pastContestPage = `https://atcoder.jp/contests/archive?lang=ja&page=${page}`;
        const response = await Proxy.get(pastContestPage, AtCoderScraper.getCookie());
        const $ = cheerio.load(response.data);
        const contestList = $('#main-container table tbody tr');
        const contestListArray = contestList.toArray();
        await Promise.all(contestListArray.map(analyzeContest));
        const pageNations = $('#main-container .pagination li').toArray();
        const maxPage = pageNations.reduce((max, elem) => {
            const pageNumber = parseInt($(elem).text().trim());
            if (!isNaN(pageNumber) && pageNumber > max) {
                return pageNumber;
            }
            return max;
        }, 0);
        return maxPage;
    }

    async function analyzeContest(elem: Element) {
        const $ = cheerio.load(elem);
        const cells = $('td').toArray();

        const startDatetime = new Date($(cells[0], 'time').text());
        const contestName = $(cells[1]).find('a').text().trim();
        const contestId = $(cells[1]).find('a').attr('href')?.split('/')[2] || '';
        const isHeuristic = $(cells[1]).find('span').first().text() == 'Ⓗ';
        const contestTypeRaw = $(cells[1]).find('span').eq(1);
        let ContestType: contestType = contestType.Unknown;
        if (contestTypeRaw.hasClass('user-blue') || contestTypeRaw.hasClass('user-green')) {
            ContestType = contestType.ABC;
        } else if (contestTypeRaw.hasClass('user-red')) {
            ContestType = contestType.AGC;
        } else if (contestTypeRaw.hasClass('user-orange') || contestTypeRaw.hasClass('user-yellow')) {
            ContestType = contestType.ARC;
        }
        const durationRaw = $(cells[2]).text().trim();
        const durationParts = durationRaw.split(':');
        const duration = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
        const endTime = new Date(startDatetime.getTime() + duration * 1000 * 60);
        const ratingRange = $(cells[3]).text().trim();
        const ratingRangeObj = {
            begin: 0,
            end: 0,
        };
        if (ratingRange == 'All') {
            ratingRangeObj.begin = -Config.maxRating;
            ratingRangeObj.end = Config.maxRating;
        } else if (ratingRange == '-') {
            ratingRangeObj.begin = -Config.maxRating;
            ratingRangeObj.end = -Config.maxRating;
        } else {
            const ratingRangeParts = ratingRange.split('~').map((v) => v.trim());
            if (ratingRangeParts[0]) {
                ratingRangeObj.begin = parseInt(ratingRangeParts[0]);
            } else {
                ratingRangeObj.begin = -Config.maxRating;
            }
            if (ratingRangeParts[1]) {
                ratingRangeObj.end = parseInt(ratingRangeParts[1]);
            } else {
                ratingRangeObj.end = Config.maxRating;
            }
        }
        await Database.getDatabase().contest.upsert({
            where: {
                id: contestId,
            },
            update: {
                title: contestName,
                startTime: startDatetime,
                endTime: endTime,
                duration: duration,
                ratingRangeBegin: ratingRangeObj.begin,
                ratingRangeEnd: ratingRangeObj.end,
                contestType: ContestType,
                isHeuristic: isHeuristic,
            },
            create: {
                id: contestId,
                title: contestName,
                startTime: startDatetime,
                endTime: endTime,
                duration: duration,
                ratingRangeBegin: ratingRangeObj.begin,
                ratingRangeEnd: ratingRangeObj.end,
                contestType: ContestType,
                isHeuristic: isHeuristic,
            },
        });
    }
    export async function getProblemPDF(contestId: string) {
        if (!existsSync(path.join(__dirname, '../../../../data/pdf', contestId + '.pdf')) && process.env.PRODUCTION != 'true') {
            const pageURL = `https://atcoder.jp/contests/${contestId}/tasks_print`;
            const browser = await puppeteer.launch();
            const page = await browser.newPage();
            await page.goto(pageURL, { waitUntil: 'networkidle0' });
            console.log('Crawling PDF:' + contestId);
            await page.pdf({
                path: path.join(__dirname, '../../../../data/pdf', contestId + '.pdf'),
                format: 'A4',
                printBackground: true,
                margin: { top: '20mm', bottom: '20mm', left: '10mm', right: '10mm' },
                timeout: 2 ** 31 - 1,
            });
            await browser.close();
        }
        await Database.getDatabase().contest.update({
            where: {
                id: contestId,
            },
            data: {
                crawledPDF: true,
            },
        });
    }
}
