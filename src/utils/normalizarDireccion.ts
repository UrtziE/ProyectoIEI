const PALABRAS_MINUSCULAS = new Set(['a', 'al', 'de', 'del', 'la', 'las', 'los', 'y']);

const capitalizarDireccion = (direccion: string): string => direccion
    .toLocaleLowerCase('es-ES')
    .split(' ')
    .map((palabra, index) => {
        if (!palabra || (index > 0 && PALABRAS_MINUSCULAS.has(palabra))) return palabra;
        return palabra.charAt(0).toLocaleUpperCase('es-ES') + palabra.slice(1);
    })
    .join(' ');

const quitarAcentos = (texto: string): string => texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

export const normalizarDireccion = (direccion: string): string => {
    let resultado = direccion.replace(/\s+/g, ' ').trim();

    resultado = resultado
        .replace(/\bC\s*\/\s*/gi, 'Calle ')
        .replace(/\bAvda?\.?\s+/gi, 'Avenida ')
        .replace(/\bCtra?\.?\s+/gi, 'Carretera ')
        .replace(/\b(calle|avenida|carretera)\s+\1\b/gi, '$1')
        .replace(/\bN[º°o]\.?\s*/gi, '')
        .replace(/\b(?:número|num\.?)\s*/gi, '')
        .replace(/\bKm\.?\s*/gi, '')
        .replace(/,\s*(?:planta|pta\.?|puerta|piso)\b[^,]*/gi, '')
        .replace(/\s*,\s*(\d+)/g, ' $1')
        .replace(/\s+/g, ' ')
        .trim();

    return capitalizarDireccion(quitarAcentos(resultado));
};
