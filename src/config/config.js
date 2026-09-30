require('dotenv').config();

const config = {
    port: Number(process.env.PORT) || 3000,
    db: {
        uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/proyecto_iei'
    }
};

module.exports = config;