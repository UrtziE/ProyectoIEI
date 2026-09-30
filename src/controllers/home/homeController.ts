import { RequestHandler } from 'express';
import Provincia from '../../models/Provincia';

export const getHomePage: RequestHandler = async (_req, res, next) => {
    try {
        if (res.locals.userId !== null) {
            const user = await Provincia.findById(res.locals.userId);
            const nombre = user?.nombre ?? 'erabiltzaile';
            res.render('home', { izena: nombre });
        } else {
            res.render('home');
        }
    } catch (error) {
        next(error);
    }
};