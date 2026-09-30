const mongoose = require("mongoose");

const EntidadSchema = new mongoose.Schema({
    cod_entidad: { 
        type: String, 
        required: [true, 'El código de entidad es necesario.'],
        unique: true 
    },
    nombre: { 
        type: String, 
        required: [true, 'El nombre es necesario.'] 
    },
    ambito: { 
        type: String, 
        required: true,
        // Enumeración exacta extraída del diagrama UML
        enum: [
            'MAYORES', 
            'DISCAPACIDAD', 
            'SALUD_MENTAL', 
            'INFANCIA_Y_JUVENTUD', 
            'MUJER', 
            'MIGRACION', 
            'INCLUSION_SOCIAL', 
            'EDUCACION_Y_FORMACION', 
            'EMPLEO_E_INSERCION_LABORAL', 
            'SALUD_Y_ATENCION_SOCIOSANITARIA', 
            'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA', 
            'CULTURA_Y_DESARROLLO_COMUNITARIO'
        ] 
    },
    direccion: { type: String }, // Sin tilde por convención de programación
    codigo_postal: { type: String }, 
    longitud: { type: Number },
    latitud: { type: Number },
    descripcion: { type: String },
    contacto: { type: String },
    URL: { type: String },
    // Relación +en_localidad del diagrama
    localidad: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Localidad',
        required: [true, 'La referencia a la localidad es obligatoria.']
    }
});

module.exports = mongoose.model("Entidad", EntidadSchema);