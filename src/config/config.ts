import 'dotenv/config';

interface Config {
    port: number;
    db: {
        uri: string;
    };
}

const config: Config = {
    port: Number(process.env.PORT) || 3000,
    db: {
        uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/proyecto_iei'
    }
};

export default config;