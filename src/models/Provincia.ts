import mongoose, { Document, Model } from 'mongoose';

export interface ProvinciaDocument extends Document {
    codigo: string;
    nombre: string;
}

const ProvinciaSchema = new mongoose.Schema<ProvinciaDocument>({
    codigo: {
        type: String,
        required: [true, 'El código de la provincia es necesario.'],
        unique: true
    },
    nombre: {
        type: String,
        required: [true, 'El nombre de la provincia es necesario.']
    }
});

const Provincia: Model<ProvinciaDocument> = mongoose.model<ProvinciaDocument>('Provincia', ProvinciaSchema);

export default Provincia;