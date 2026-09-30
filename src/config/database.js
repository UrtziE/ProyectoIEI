const mongoose = require("mongoose");
const config = require("./config");

const connectDB = async () => {
    try {
        await mongoose.connect(config.db.uri);
        console.log('[DB] Connected to MongoDB');
    } catch (err) {
        console.error('[DB] Connection error:', err.message);
        throw err;
    }
};

mongoose.connection.on('error', (err) => {
    console.error('[DB] Runtime error:', err);
});

module.exports = connectDB;
