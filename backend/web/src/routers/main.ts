import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
    res.render('index');
});

router.get('/special/418', (req, res) => {
    res.render('special/418');
});

export default router;
