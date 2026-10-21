import mongoose from 'mongoose';

const vaciarBaseDatos = async (): Promise<void> => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('No se puede vaciar la base de datos porque MongoDB no está conectado.');
    }

    await mongoose.connection.dropDatabase();
    console.log('[DB] Base de datos vaciada');
};

export default vaciarBaseDatos;
