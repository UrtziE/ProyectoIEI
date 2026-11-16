import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { Ambito, ambitos } from '../models/Entidad';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const BATCH_SIZE = 25;          // entidades por petición (la capa gratuita limita las peticiones, no las entidades)
const DELAY_BETWEEN_BATCHES_MS = 4000;
const MAX_ATTEMPTS = 1;
const AI_TIMEOUT_MS = 30000;

export interface EntidadParaClasificar {
    nombre: string;
    descripcion?: string;
}

interface ClasificacionIA {
    id: number;
    ambito: string;
}

const AMBITO_VALIDOS: readonly string[] = ambitos;

const RESPONSE_SCHEMA = {
    type: 'array',
    items: {
        type: 'object',
        properties: {
            id: { type: 'integer' },
            ambito: { type: 'string', enum: [...ambitos] }
        },
        required: ['id', 'ambito']
    }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const buildPrompt = (batch: EntidadParaClasificar[]): string => {
    const lista = batch
        .map((item, index) => `${index}: ${item.nombre}${item.descripcion ? ` (${item.descripcion})` : ''}`)
        .join('\n');

    return [
        'Eres un clasificador de organizaciones del tercer sector en España (ONG, asociaciones y fundaciones).',
        'Asigna a cada organización UN ámbito de actuación principal, a partir de su nombre.',
        `Ámbitos permitidos: ${ambitos.join(', ')}.`,
        'Reglas:',
        '- Usa exactamente uno de los ámbitos permitidos.',
        '- Si el nombre no permite deducir el ámbito con razonable seguridad, usa SIN_CLASIFICAR. No inventes.',
        '- Los nombres pueden estar en castellano o catalán y a veces vienen sin espacios entre palabras.',
        '- Devuelve un elemento por organización, con su id (el número de la lista).',
        '',
        'Organizaciones:',
        lista
    ].join('\n');
};

const classifyBatch = async (ai: GoogleGenAI, batch: EntidadParaClasificar[]): Promise<Array<Ambito | undefined>> => {
    const response = await ai.models.generateContent({
        model: MODEL,
        contents: buildPrompt(batch),
        config: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseJsonSchema: RESPONSE_SCHEMA,
            httpOptions: {
                timeout: AI_TIMEOUT_MS,
                retryOptions: { attempts: 1 }
            }
        }
    });

    const parsed: unknown = JSON.parse(response.text ?? '[]');
    if (!Array.isArray(parsed)) {
        throw new Error('La respuesta de Gemini no es un array JSON.');
    }

    // Se valida todo: id dentro del lote y ámbito dentro de la lista permitida
    const result: Array<Ambito | undefined> = new Array(batch.length).fill(undefined);
    for (const item of parsed as ClasificacionIA[]) {
        if (Number.isInteger(item?.id) && item.id >= 0 && item.id < batch.length && AMBITO_VALIDOS.includes(item.ambito)) {
            result[item.id] = item.ambito as Ambito;
        }
    }

    return result;
};

/**
 * Clasifica entidades por ámbito con Gemini. Devuelve un array del mismo tamaño que la entrada:
 * Nunca lanza errores: quien lo llama usa su propio método de respaldo para los undefined.
 */
export const clasificarAmbitosConIA = async (
    entidades: EntidadParaClasificar[]
): Promise<Array<Ambito | undefined>> => {
    const results: Array<Ambito | undefined> = new Array(entidades.length).fill(undefined);
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.warn('[IA] GEMINI_API_KEY no está definida: se usarán las palabras clave.');
        return results;
    }
    if (entidades.length === 0) {
        return results;
    }

    const ai = new GoogleGenAI({ apiKey });

    for (let start = 0; start < entidades.length; start += BATCH_SIZE) {
        const batch = entidades.slice(start, start + BATCH_SIZE);

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const classified = await classifyBatch(ai, batch);
                classified.forEach((ambito, index) => {
                    results[start + index] = ambito;
                });
                break;
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                if (attempt === MAX_ATTEMPTS) {
                    console.warn(`[IA] Lote ${start + 1}-${start + batch.length} sin clasificar: ${message}`);
                } else {
                    await sleep(DELAY_BETWEEN_BATCHES_MS * attempt * 2); // espera creciente (cuota por minuto)
                }
            }
        }

        if (start + BATCH_SIZE < entidades.length) {
            await sleep(DELAY_BETWEEN_BATCHES_MS);
        }
    }

    return results;
};
