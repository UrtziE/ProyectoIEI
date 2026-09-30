import app from './app';
import config from './config/config';
import connectDB from './config/database';

const startServer = async (): Promise<void> => {
    await connectDB();

    app.listen(config.port, () => {
        console.log(`Server running on http://localhost:${config.port}`);
    });
};

void startServer();