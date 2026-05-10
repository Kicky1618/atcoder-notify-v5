import {
    Prisma,
    SubmissionStatus as PrismaSubmissionStatus,
    SubmissionStatus,
} from '@prisma/client';
import { Main } from '../..';
import {
    Submission,
    SubmissionWithoutTimeAndMemory,
    SubmissionWithTimeAndMemory,
} from './getSubmissions';
import { Database } from '../../database';

export async function convertPrismaSubmissionToScraperSubmission(
    submission: Prisma.submissionsGetPayload<{}>,
): Promise<Submission> {
    const db = Database.getDatabase();
    const [userRecord, taskRecord] = await Promise.all([
        db.user.findUnique({
            where: { id: submission.userId },
            select: { name: true },
        }),
        db.tasks.findUnique({
            where: { id: submission.taskId },
            select: { contestid: true, taskid: true },
        }),
    ]);

    if (!userRecord) {
        Main.getLogger().fatal(`User not found for submission ${submission.submissionId}`);
        throw new Error(`User not found for submission ${submission.submissionId.toString()}`);
    }

    if (!taskRecord) {
        Main.getLogger().fatal(`Task not found for submission ${submission.submissionId}`);
        throw new Error(`Task not found for submission ${submission.submissionId.toString()}`);
    }

    const baseSubmission = {
        status: convertPrismaSubmissionStatusToScraper(submission.status),
        contestId: taskRecord.contestid,
        problemId: taskRecord.taskid,
        datetime: submission.datetime,
        username: userRecord.name,
        language: submission.language,
        score: submission.score,
        codeLength: submission.codeLength,
        submissionId: submission.submissionId,
    };

    if (
        submission.status === PrismaSubmissionStatus.CE ||
        submission.status === PrismaSubmissionStatus.WJ ||
        submission.status === PrismaSubmissionStatus.WR ||
        submission.status === PrismaSubmissionStatus.IE
    ) {
        return baseSubmission as SubmissionWithoutTimeAndMemory;
    }

    return {
        ...baseSubmission,
        time: submission.time,
        memory: submission.memory,
    } as SubmissionWithTimeAndMemory;
}

export function convertPrismaSubmissionStatusToScraper(
    status: PrismaSubmissionStatus,
): SubmissionStatus {
    switch (status) {
        case PrismaSubmissionStatus.AC:
            return SubmissionStatus.AC;
        case PrismaSubmissionStatus.WA:
            return SubmissionStatus.WA;
        case PrismaSubmissionStatus.TLE:
            return SubmissionStatus.TLE;
        case PrismaSubmissionStatus.MLE:
            return SubmissionStatus.MLE;
        case PrismaSubmissionStatus.RE:
            return SubmissionStatus.RE;
        case PrismaSubmissionStatus.CE:
            return SubmissionStatus.CE;
        case PrismaSubmissionStatus.QLE:
            return SubmissionStatus.QLE;
        case PrismaSubmissionStatus.OLE:
            return SubmissionStatus.OLE;
        case PrismaSubmissionStatus.IE:
            return SubmissionStatus.IE;
        case PrismaSubmissionStatus.WJ:
            return SubmissionStatus.WJ;
        case PrismaSubmissionStatus.WR:
            return SubmissionStatus.WR;
        default:
            Main.getLogger().fatal(`Unhandled submission status: ${status}`);
            throw new Error(`Unhandled submission status: ${status}`);
    }
}

export async function convertScraperSubmissionToPrismaSubmission(
    submission: Submission,
): Promise<
    Prisma.submissionsUncheckedCreateInput & Prisma.submissionsUncheckedUpdateInput
> {
    const db = Database.getDatabase();
    let userRecord = await db.user.findFirst({
        where: { name: submission.username },
        select: { id: true },
    });

    if (!userRecord) {
        userRecord = await db.user.create({
            data: { name: submission.username },
            select: { id: true },
        });
    }

    let taskRecord = await db.tasks.findFirst({
        where: { contestid: submission.contestId, taskid: submission.problemId },
        select: { id: true },
    });

    if (!taskRecord) {
        Main.getLogger().warn(`Task not found for contest ${submission.contestId}, problem ${submission.problemId}. Creating it automatically.`);
        taskRecord = await db.tasks.create({
            data: {
                contestid: submission.contestId,
                taskid: submission.problemId,
            },
            select: { id: true },
        });
    }

    const sharedFields = {
        submissionId: submission.submissionId,
        status: convertScraperSubmissionStatusToPrisma(submission.status),
        datetime: submission.datetime,
        userId: userRecord.id,
        codeLength: submission.codeLength,
        language: submission.language,
        score: submission.score,
        taskId: taskRecord.id,
    };

    if (
        submission.status === SubmissionStatus.CE ||
        submission.status === SubmissionStatus.WJ ||
        submission.status === SubmissionStatus.WR ||
        submission.status === SubmissionStatus.IE
    ) {
        const prismaSubmission = {
            ...sharedFields,
            time: -1,
            memory: -1,
        } satisfies Prisma.submissionsUncheckedCreateInput & Prisma.submissionsUncheckedUpdateInput;
        return prismaSubmission;
    }

    const submissionWithTimeAndMemory = submission as SubmissionWithTimeAndMemory;
    const prismaSubmission = {
        ...sharedFields,
        time: submissionWithTimeAndMemory.time,
        memory: submissionWithTimeAndMemory.memory,
    } satisfies Prisma.submissionsUncheckedCreateInput & Prisma.submissionsUncheckedUpdateInput;
    return prismaSubmission;
}

export function convertScraperSubmissionStatusToPrisma(
    status: SubmissionStatus,
): PrismaSubmissionStatus {
    switch (status) {
        case SubmissionStatus.AC:
            return PrismaSubmissionStatus.AC;
        case SubmissionStatus.WA:
            return PrismaSubmissionStatus.WA;
        case SubmissionStatus.TLE:
            return PrismaSubmissionStatus.TLE;
        case SubmissionStatus.MLE:
            return PrismaSubmissionStatus.MLE;
        case SubmissionStatus.RE:
            return PrismaSubmissionStatus.RE;
        case SubmissionStatus.CE:
            return PrismaSubmissionStatus.CE;
        case SubmissionStatus.QLE:
            return PrismaSubmissionStatus.QLE;
        case SubmissionStatus.OLE:
            return PrismaSubmissionStatus.OLE;
        case SubmissionStatus.IE:
            return PrismaSubmissionStatus.IE;
        case SubmissionStatus.WJ:
            return PrismaSubmissionStatus.WJ;
        case SubmissionStatus.WR:
            return PrismaSubmissionStatus.WR;
        default:
            Main.getLogger().fatal(`Unhandled submission status: ${status}`);
            throw new Error(`Unhandled submission status: ${status}`);
    }
}
