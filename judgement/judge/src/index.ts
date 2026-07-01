import { createClient } from 'redis';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import Docker from 'dockerode';
import { PrismaClient } from '@prisma/client';
import os from 'os';
import { PassThrough } from 'stream';
import { config } from 'dotenv';
config({ path: path.join(__dirname, '../../../.env') });

interface TestConfig {
    tests: { sample: string[]; handmade: string[]; random: string[] };
    memoryLimit: number;
    timeLimit: number;
}
interface Job {
    language: string;
    code: string;
    problemId: string;
    judgementId: string;
}
interface JudgeResult {
    is_success: boolean;
    is_timeout: boolean;
    err?: string;
    output?: string;
    spend_time: number;
}

const REDIS_QUEUE = 'judgement';

async function main() {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const redisRead = createClient({ url: redisUrl });
    const redisWrite = createClient({ url: redisUrl });
    const dockerClient = new Docker({ host: process.env.DOCKER_HOST || 'localhost', port: Number(process.env.DOCKER_PORT) || 2375 });
    await redisRead.connect();
    await redisWrite.connect();
    console.log('🔗 Connected to Redis');

    while (true) {
        try {
            const res = await redisRead.blPop(REDIS_QUEUE, 0);
            if (!res) continue;
            const { language, code, problemId, judgementId }: Job = JSON.parse(res.element);
            const subDir = path.join(__dirname, '../../submissions', judgementId);
            fsSync.mkdirSync(subDir, { recursive: true });

            const images = JSON.parse(await fs.readFile(path.join(__dirname, '../../containers/languages.json'), 'utf-8'));
            const imageName = images[language];
            if (!imageName) {
                console.error(`No image for ${language}`);
                continue;
            }
            const langCfg = JSON.parse(await fs.readFile(path.join(__dirname, `../../containers/${imageName}/language_config.json`), 'utf-8'));
            await fs.writeFile(path.join(subDir, langCfg.filename), code);

            if (!fsSync.existsSync(path.join(__dirname, '../../problems', problemId))) {
                console.error(`Problem directory for ${problemId} does not exist`);
                continue;
            }
            const testCfg: TestConfig = JSON.parse(await fs.readFile(path.join(__dirname, '../../problems', problemId, 'tests.json'), 'utf-8'));
            const tests = [...testCfg.tests.sample, ...testCfg.tests.handmade, ...testCfg.tests.random];

            const container = await dockerClient.createContainer({
                Image: `kyo-pro-club-judge/${imageName}`,
                Cmd: ['tail', '-f', '/dev/null'],
                Tty: true,
                User: '65534',
                HostConfig: {
                    CpuCount: 1,
                    Memory: testCfg.memoryLimit * 1024 * 1024,
                    Binds: [`${subDir}:/opt/judge/submission`],
                    ReadonlyRootfs: true,
                    PidsLimit: 128,
                    NetworkMode: 'none',
                    CapDrop: ['ALL'],
                    SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'],
                    Tmpfs: { '/opt/judge/runtime': 'rw,noexec,nosuid,size=64m' },
                    AutoRemove: false,
                    RestartPolicy: { Name: 'unless-stopped' },
                },
            });
            await container.start();
            try {
                if (!langCfg.is_interpreter) {
                    await fs.writeFile(
                        path.join(subDir, 'problem_config.json'),
                        JSON.stringify({ memory_limit: testCfg.memoryLimit, timeout: testCfg.timeLimit, is_build: true }),
                    );
                    const buildExec = await container.exec({
                        Cmd: ['/usr/local/bin/judge-runner'],
                        AttachStdout: true,
                        AttachStderr: true,
                        Tty: false,
                    });
                    const rawBuildStream = await buildExec.start({ hijack: true, stdin: false });

                    const stdoutBuild = new PassThrough();
                    const stderrBuild = new PassThrough();
                    dockerClient.modem.demuxStream(rawBuildStream, stdoutBuild, stderrBuild);

                    rawBuildStream.on('end', () => {
                        stdoutBuild.end();
                        stderrBuild.end();
                    });

                    let bufB = '';
                    stdoutBuild.on('data', (c: Buffer) => {
                        bufB += c.toString();
                    });
                    await new Promise<void>((r) => stdoutBuild.on('end', r));

                    while (!bufB.startsWith('{')) bufB = bufB.substring(1);
                    while (!bufB.endsWith('}')) bufB = bufB.slice(0, -1);

                    let bRes: JudgeResult;
                    try {
                        bRes = JSON.parse(bufB.trim());
                    } catch (e) {
                        console.error('Failed to parse build JSON:', e, bufB);
                        await container.remove({ force: true });
                        fs.rm(path.join(__dirname, '../../submissions', judgementId), { recursive: true }).catch(() => {});
                        continue;
                    }
                    if (!bRes.is_success) {
                        console.error(`Build failed: ${bRes.err}`);
                        await container.remove({ force: true });
                        fs.rm(path.join(__dirname, '../../submissions', judgementId), { recursive: true }).catch(() => {});
                        continue;
                    }
                }
                console.log(`Build successful for judgement ${judgementId}`);

                for (const testName of tests) {
                    await fs.writeFile(
                        path.join(subDir, 'input.txt'),
                        await fs.readFile(path.join(__dirname, '../../problems', problemId, 'testcases', `${testName}.in`), 'utf-8'),
                    );
                    await fs.writeFile(
                        path.join(subDir, 'problem_config.json'),
                        JSON.stringify({ memory_limit: testCfg.memoryLimit, timeout: testCfg.timeLimit, is_build: false }),
                    );

                    const testExec = await container.exec({
                        Cmd: ['/usr/local/bin/judge-runner'],
                        AttachStdout: true,
                        AttachStderr: true,
                        Tty: false,
                    });
                    const rawTestStream = await testExec.start({ hijack: true, stdin: false });

                    const stdoutTest = new PassThrough();
                    const stderrTest = new PassThrough();
                    dockerClient.modem.demuxStream(rawTestStream, stdoutTest, stderrTest);
                    rawTestStream.on('end', () => {
                        stdoutTest.end();
                        stderrTest.end();
                    });

                    let bufT = '';
                    stdoutTest.on('data', (c: Buffer) => {
                        bufT += c.toString();
                    });
                    await new Promise<void>((r) => stdoutTest.on('end', r));

                    while (!bufT.startsWith('{')) bufT = bufT.substring(1);
                    while (!bufT.endsWith('}')) bufT = bufT.slice(0, -1);

                    let tRes: JudgeResult;
                    try {
                        tRes = JSON.parse(bufT.trim());
                    } catch (e) {
                        console.error('Failed to parse test JSON:', e, bufT);
                        continue;
                    }
                    tRes.output = await fs.readFile(path.join(subDir, 'out.txt'), 'utf-8').catch(() => '');
                    const key = `judge_result_${judgementId}`;
                    if (!tRes.is_success) {
                        await redisWrite.rPush(
                            key,
                            JSON.stringify({ test: testName, status: tRes.is_timeout ? 'timeout' : 'failed', error: tRes.err, time: tRes.spend_time }),
                        );
                    } else {
                        const expected = (await fs.readFile(path.join(__dirname, '../../problems', problemId, 'testcases', `${testName}.out`), 'utf-8'))
                            .replace(/\r?\n/g, '\n')
                            .trim();
                        if ((tRes.output || '').trim() === expected) {
                            await redisWrite.rPush(key, JSON.stringify({ test: testName, status: 'passed', time: tRes.spend_time }));
                        } else {
                            await redisWrite.rPush(key, JSON.stringify({ test: testName, status: 'failed', error: 'Output mismatch', time: tRes.spend_time }));
                        }
                    }

                    await container
                        .exec({
                            Cmd: ['sh', '-c', `find /opt/judge/runtime -mindepth 1 -delete`],
                            AttachStdout: false,
                            AttachStderr: false,
                        })
                        .then((e) => e.start({ hijack: false, stdin: false }));
                }
            } finally {
                await container.remove({ force: true }).catch(() => {});
                fs.rm(path.join(__dirname, '../../submissions', judgementId), { recursive: true }).catch(() => {});
            }
        } catch (e) {
            console.error('Error BLPOP:', e);
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
