const PALABRAS_MINUSCULAS = new Set(['a', 'al', 'de', 'del', 'i', 'la', 'las', 'los', 'y']);

const capitalizarDireccion = (direccion: string): string => direccion
    .toLocaleLowerCase('es-ES')
    .split(' ')
    .map((palabra, index) => {
        if (!palabra || (index > 0 && PALABRAS_MINUSCULAS.has(palabra))) return palabra;
        return palabra.charAt(0).toLocaleUpperCase('es-ES') + palabra.slice(1);
    })
    .join(' ');

const quitarAcentos = (texto: string): string => texto
    .replace(/ç/g, '__cedilla_minuscula__')
    .replace(/Ç/g, '__cedilla_mayuscula__')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/__cedilla_minuscula__/g, 'ç')
    .replace(/__cedilla_mayuscula__/g, 'Ç');

export const separarPalabrasPegadas = (texto: string): string => texto
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([a-zà-ÿ])(perla|perel|dela|dels|deles|enla|ambles|ambels)/gi, '$1 $2')
    .replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, '$1 $2')
    .replace(/([a-df-zà-ÿ])i\s*([A-ZÀ-Ý])/g, '$1 i $2')
    .replace(/([a-zà-ÿ])de\s*([A-ZÀ-Ý])/g, '$1 de $2')
    .replace(/(perla|perel|dela|dels|deles|enla|ambles|ambels)\s*(?=[A-ZÀ-Ý])/gi, (coincidencia) =>
        coincidencia
            .replace(/perla/i, 'per la')
            .replace(/perel/i, 'per el')
            .replace(/dela/i, 'de la')
            .replace(/dels/i, 'dels')
            .replace(/deles/i, 'de les')
            .replace(/enla/i, 'en la')
            .replace(/ambles/i, 'amb les')
            .replace(/ambels/i, 'amb els')
    );

export const normalizarDireccion = (direccion: string): string => {
    let resultado = direccion.replace(/\s+/g, ' ').trim();

    resultado = resultado
        .replace(/\b(Plaça|Carrer|Avinguda|Avenida|Calle|Carretera|Travessera|Passeig|Ronda)(?=[A-Za-zÀ-ÿ])/gi, '$1 ')
        .replace(/([A-Za-zÀ-ÿ])(\d)/g, '$1 $2')
        .replace(/(\d)([A-Za-zÀ-ÿ])/g, '$1 $2')
        .replace(/\bC\s*\/\s*/gi, 'Calle ')
        .replace(/\bAvda?\.?\s+/gi, 'Avenida ')
        .replace(/\bCtra?\.?\s+/gi, 'Carretera ')
        .replace(/\b(calle|avenida|carretera)\s+\1\b/gi, '$1')
        .replace(/\bN[º°o]\.?\s*/gi, '')
        .replace(/\b(?:número|num\.?)\s*/gi, '')
        .replace(/\bKm\.?\s*/gi, '')
        .replace(/,\s*(?:planta|pta\.?|puerta|piso)\b[^,]*/gi, '')
        .replace(/(\d+)\s+(?:local|àtic|atic|baixos?|bajo|entresuelo|entresol|principal)\b[\wºª\s]*/gi, '$1')
        .replace(/,\s*(?:local|àtic|atic|baixos?|bajo|entresuelo|entresol|principal)\b[\wºª]*/gi, '')
        .replace(/\s*,\s*(\d+)/g, ' $1')
        .replace(/\s+/g, ' ')
        .trim();

    return capitalizarDireccion(quitarAcentos(resultado));
};
