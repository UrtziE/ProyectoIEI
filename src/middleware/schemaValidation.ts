import mongoose, { Schema } from 'mongoose';

const isNonBlank = (value: string): boolean => value.trim().length > 0;

const isPostalCode = (value: string): boolean => /^\d{5}$/.test(value);

const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

export const nonBlankString = {
    validator: isNonBlank,
    message: 'El campo no puede estar vacío.'
};

export const postalCode = {
    validator: isPostalCode,
    message: 'El código postal debe tener exactamente 5 dígitos.'
};

export const longitude = {
    validator: (value: number): boolean => value >= -180 && value <= 180,
    message: 'La longitud debe estar entre -180 y 180.'
};

export const latitude = {
    validator: (value: number): boolean => value >= -90 && value <= 90,
    message: 'La latitud debe estar entre -90 y 90.'
};

export const httpUrl = {
    validator: isHttpUrl,
    message: 'La URL debe ser válida y comenzar por http:// o https://.'
};

/**
 * Mongoose no ejecuta validadores automáticamente en las actualizaciones.
 * Este middleware obliga a usar runValidators también en update/upsert.
 */
export const enableUpdateValidation = <T extends mongoose.Document>(
    schema: Schema<T>
): void => {
    schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
        this.setOptions({ runValidators: true });
    });
};
