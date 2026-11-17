import mongoose from 'mongoose';
import connectDB from '../config/database';

const vaciarBaseDatos = async (): Promise<void> => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('No se puede vaciar la base de datos porque MongoDB no está conectado.');
    }

    await mongoose.connection.dropDatabase();
    console.log('[DB] Base de datos vaciada');
};

export default vaciarBaseDatos;

if (require.main === module) {
    (async (): Promise<void> => {
        try {
            await connectDB();
            await vaciarBaseDatos();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[DB] Error al vaciar la base de datos: ${message}`);
            process.exitCode = 1;
        } finally {
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        }
    })();
}
