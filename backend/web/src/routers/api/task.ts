import z from "zod";
import { Router } from "express";
import { Database } from "../../database";

const router = Router();

router.get("/spendTimes", async (req,res) => {
    const QuerySchema = z.object({
        contest: z.string(),
        task: z.string(),
        language: z.string().optional(),
    });
    const query = QuerySchema.safeParse(req.query);
    if (!query.success) {
        return res.status(400).json({ error: "Invalid query parameters" });
    }
    const { contest, task, language } = query.data;
    const taskRow = await Database.getDatabase().tasks.findMany({
        where: { contestid: contest, taskid: task },
        select: { id: true },
    })
    if (taskRow.length === 0) {
        res.json([]);
        return;
    }
    const h = (await Database.getDatabase().submissions.groupBy({
        by: ['time'],
        where: {
            taskId: taskRow[0].id,
            status: 'AC',
            language: language || undefined
        },
        _count: {
            time: true
        }
    })).map((e) => {
        return {
            time: e.time,
            count: e._count.time
        }
    })
    res.json(h);
})
router.get("/languages",async (req,res) => {
    const languages = await Database.getDatabase().submissions.groupBy({
        by: ['language'],
    })
    res.json(languages);
})

export default router;
