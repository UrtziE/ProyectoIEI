const app = require('./app');
const config = require('./config/config');
const connectDB = require('./config/database');

const startServer = async () => {
    await connectDB();

    app.listen(config.port, () => {
        console.log(`Server running on http://localhost:${config.port}`);
    });
};

startServer();

