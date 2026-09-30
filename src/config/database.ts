import mongoose from 'mongoose';
import config from './config';

const connectDB = async (): Promise<void> => {
    try {
        await mongoose.connect(config.db.uri);
        console.log('[DB] Connected to MongoDB');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[DB] Connection error:', message);
        throw error;
    }
};

mongoose.connection.on('error', (error: Error) => {
    console.error('[DB] Runtime error:', error);
});

export default connectDB;