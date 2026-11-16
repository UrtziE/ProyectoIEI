import mongoose from 'mongoose';
import connectDB from '../config/database';
import { extraer, extraerJsonCV } from './extractorCV';
import { extractCAN } from './extractorCAN';
import { extractCAT } from './extractorCat';
import vaciarBaseDatos from '../utils/vaciarBaseDatos';

const run = async (): Promise<void> => {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log('Uso: npm run extract:all');
        console.log('Importa CV, CAN y CAT en ese orden y vacía MongoDB una sola vez al comenzar.');
        return;
    }

    console.log('[ALL] Conectando a MongoDB y vaciando la base de datos...');
    await connectDB();
    await vaciarBaseDatos();

    const cvEntities = await extraer(extraerJsonCV());
    console.log(`[ALL] CV completado: ${cvEntities.length} entidades.`);

    const canSummary = await extractCAN(undefined, { clearDatabase: false });
    console.log(
        `[ALL] CAN completado: ${canSummary.entidades} entidades, ` +
        `${canSummary.rechazados.length} rechazados.`
    );

    const catSummary = await extractCAT(undefined, { clearDatabase: false });
    console.log(
        `[ALL] CAT completado: ${catSummary.entidades} entidades, ` +
        `${catSummary.rechazados.length} rechazados y ${catSummary.duplicados.length} duplicados.`
    );
};

if (require.main === module) {
    run()
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ALL] Error durante la importación: ${message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        });
}
