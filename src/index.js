require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const pool = require('./config/db'); // Pool de conexiones a MySQL

const app = express();
app.use(cors());
app.use(express.json()); // Permite leer JSON en las peticiones
app.use(express.static(path.join(__dirname, 'public')));


const CHEAPSHARK = 'https://www.cheapshark.com/api/1.0';
const HEADERS = { 'User-Agent': 'ChipsGame/1.0 (proyecto personal)' };

const MAX_RESULTADOS = 5;                    // juegos que se muestran por búsqueda
const CANDIDATOS = 60;                       // juegos que pedimos a CheapShark para ordenarlos por parecido
const PAUSA_ENTRE_LLAMADAS_MS = 400;         // espera entre llamadas a CheapShark
const CACHE_BUSQUEDA_MS = 30 * 60 * 1000;    // una búsqueda repetida se sirve de memoria 30 min
const CACHE_JUEGO_MS = 6 * 60 * 60 * 1000;   // los precios de un juego se refrescan cada 6 h
const PAUSA_SI_LIMITA_MS = 5 * 60 * 1000;    // si CheapShark nos limita, no lo llamamos en 5 min

// Tiendas de CheapShark: id, nombre y url.
const TIENDAS = [
    [1,  'Steam',          'https://store.steampowered.com'],
    [2,  'GamersGate',     'https://www.gamersgate.com'],
    [3,  'GreenManGaming', 'https://www.greenmangaming.com'],
    [7,  'GOG',            'https://www.gog.com'],
    [11, 'Humble Store',   'https://www.humblebundle.com/store'],
    [15, 'Fanatical',      'https://www.fanatical.com'],
    [21, 'WinGameStore',   'https://www.wingamestore.com'],
    [23, 'GameBillet',     'https://www.gamebillet.com'],
    [24, 'Voidu',          'https://www.voidu.com'],
    [25, 'Epic Games',     'https://store.epicgames.com'],
    [28, 'Gamesload',      'https://www.gamesload.com'],
    [30, 'IndieGala',      'https://www.indiegala.com'],
    [32, 'AllYouPlay',     'https://www.allyouplay.com']
];
const NOMBRES_TIENDAS = new Map(TIENDAS.map(([id, nombre]) => [id, nombre]));

//ESTADO EN MEMORIA (se reinicia al apagar el servidor)
  
const cacheBusquedas = new Map(); // "término" -> { hasta, resultados }
const ultimaConsulta = new Map(); // gameID de CheapShark -> momento del último refresco de precios
let bloqueadoHasta = 0;           // mientras dure, no se llama a CheapShark

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ORDEN POR PARECIDO CON LO BUSCADO
function normalizar(texto) {
    return String(texto ?? '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
        .replace(/[™®©]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')                       // signos fuera
        .trim();
}

function puntuar(titulo, consulta) {
    const t = normalizar(titulo);
    const q = normalizar(consulta);
    if (!t || !q) return 0;
    if (t === q) return 1000;                               // título exacto

    let puntos = 0;
    if (t.startsWith(q)) puntos += 600;                     // empieza por lo buscado
    else if (t.includes(q)) puntos += 400;                  // contiene la frase completa

    // Cuántas palabras buscadas aparecen (completas = 1, empezadas por ellas = 0.6)
    const palabrasT = t.split(' ');
    const palabrasQ = q.split(' ');
    const aciertos = palabrasQ.reduce((suma, p) => {
        if (palabrasT.includes(p)) return suma + 1;
        if (palabrasT.some((w) => w.startsWith(p))) return suma + 0.6;
        return suma;
    }, 0);
    puntos += 200 * (aciertos / palabrasQ.length);

    // Cuantas menos palabras sobren
    puntos -= Math.min(100, Math.max(0, palabrasT.length - palabrasQ.length) * 10);
    return puntos;
}

function ordenarPorParecido(juegos, consulta) {
    return juegos
        .map((juego, posicion) => ({ juego, posicion, puntos: puntuar(juego.external, consulta) }))
        .sort((a, b) => b.puntos - a.puntos || a.posicion - b.posicion)
        .map((x) => x.juego);
}

// LLAMADAS A CHEAPSHARK
function errorDeLimite() {
    bloqueadoHasta = Date.now() + PAUSA_SI_LIMITA_MS;
    console.error(`CheapShark está limitando las peticiones. Sin llamar a su API durante ${PAUSA_SI_LIMITA_MS / 60000} min.`);
    const err = new Error('CheapShark limita las peticiones');
    err.limitado = true;
    return err;
}

async function cheapshark(ruta, params) {
    if (Date.now() < bloqueadoHasta) {
        const err = new Error('En pausa por límite de peticiones');
        err.limitado = true;
        throw err;
    }

    let respuesta;
    try {
        respuesta = await axios.get(`${CHEAPSHARK}/${ruta}`, { params, headers: HEADERS, timeout: 10000 });
    } catch (err) {
        const cuerpo = JSON.stringify(err.response?.data ?? '');
        if (err.response?.status === 429 || /rate limit/i.test(cuerpo)) throw errorDeLimite();
        throw err;
    }

    // A veces el aviso llega con código 200 y un JSON {"error": "..."}
    const aviso = typeof respuesta.data?.error === 'string' ? respuesta.data.error : '';
    if (/rate limit/i.test(aviso)) throw errorDeLimite();

    return respuesta.data;
}

// BASE DE DATOS
   
// Se ejecuta una sola vez al arrancar
async function prepararTiendas() {
    await pool.query(
        `INSERT INTO tiendas (id, nombre, url_base) VALUES ?
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), url_base = VALUES(url_base)`,
        [TIENDAS]
    );
}

// Guarda el juego y devuelve su id interno
// Si el título ya existía con otro gameID, devuelve el id de esa fila en vez de romper.
async function guardarJuego(item) {
    const [r] = await pool.query(
        `INSERT INTO juegos (titulo, juego_id_externo, imagen_url)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE imagen_url = VALUES(imagen_url), id = LAST_INSERT_ID(id)`,
        [item.external, item.gameID, item.thumb]
    );
    return r.insertId;
}

async function guardarPrecios(juegoId, deals = []) {
    for (const deal of deals) {
        const tiendaId = parseInt(deal.storeID, 10);
        const precio = parseFloat(deal.price);
        if (!NOMBRES_TIENDAS.has(tiendaId) || Number.isNaN(precio)) continue;

        await pool.query(
            `INSERT INTO precios (juego_id, tienda_id, precio_actual)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE precio_actual = VALUES(precio_actual)`,
            [juegoId, tiendaId, precio]
        );
    }
}

// cuando CheapShark  limita: juegos que ya tenemos guardados con precios
async function responderDesdeLocal(res, termino) {
    const [filas] = await pool.query(
        `SELECT j.id AS id_interno, j.titulo AS title, j.imagen_url AS thumbnail
         FROM juegos j
         WHERE j.titulo LIKE ?
           AND EXISTS (SELECT 1 FROM precios p WHERE p.juego_id = j.id)
         ORDER BY (j.titulo = ?) DESC, (j.titulo LIKE ?) DESC, CHAR_LENGTH(j.titulo) ASC
         LIMIT ?`,
        [`%${termino}%`, termino, `${termino}%`, MAX_RESULTADOS]
    );

    if (filas.length > 0) {
        return res.json({
            exito: true,
            fuente: 'Base de datos local (CheapShark está limitando las peticiones)',
            resultados: filas
        });
    }

    const minutos = Math.max(1, Math.ceil((bloqueadoHasta - Date.now()) / 60000));
    return res.status(429).json({
        exito: false,
        mensaje: `CheapShark está limitando las peticiones. Vuelve a intentarlo en unos ${minutos} min.`
    });
}

//RUTAS
app.get('/api/buscar-juego/:titulo', async (req, res) => {
    const termino = req.params.titulo.trim();
    if (!termino) {
        return res.status(400).json({ exito: false, mensaje: 'Escribe el nombre de un juego.' });
    }
    const clave = termino.toLowerCase();

    //  Se responde sin llamar a CheapShark
    const guardada = cacheBusquedas.get(clave);
    if (guardada && guardada.hasta > Date.now()) {
        return res.json({ exito: true, fuente: 'caché', resultados: guardada.resultados });
    }

    try {
        // Una llamada para buscar los juegos
        let juegosExternos;
        try {
            juegosExternos = await cheapshark('games', { title: termino, limit: CANDIDATOS });
        } catch (err) {
            if (err.limitado) return await responderDesdeLocal(res, termino);
            throw err;
        }

        if (!Array.isArray(juegosExternos) || juegosExternos.length === 0) {
            return res.json({ exito: true, resultados: [] });
        }

        // Precios de cada juego solo si no se han refrescado hace poco
        const resultados = [];
        let usarApi = true;   // pasa a false en cuanto CheapShark limita
        let cachear = true;   // una búsqueda con datos incompletos no se guarda en caché

        const elegidos = ordenarPorParecido(juegosExternos, termino).slice(0, MAX_RESULTADOS);

        for (const item of elegidos) {
            const juegoId = await guardarJuego(item);

            const reciente = (ultimaConsulta.get(item.gameID) ?? 0) > Date.now() - CACHE_JUEGO_MS;
            if (!reciente) {
                if (!usarApi) {
                    cachear = false;
                } else {
                    try {
                        await dormir(PAUSA_ENTRE_LLAMADAS_MS);
                        const detalle = await cheapshark('games', { id: item.gameID });
                        await guardarPrecios(juegoId, detalle.deals);
                        ultimaConsulta.set(item.gameID, Date.now());
                    } catch (err) {
                        cachear = false;
                        if (err.limitado) usarApi = false; // dejamos de llamar al resto de juegos
                        console.error(`No se pudieron obtener los precios de ${item.external}:`, err.message);
                    }
                }
            }

            resultados.push({ title: item.external, id_interno: juegoId, thumbnail: item.thumb });
        }

        if (cachear) {
            cacheBusquedas.set(clave, { hasta: Date.now() + CACHE_BUSQUEDA_MS, resultados });
        }

        res.json({ exito: true, fuente: 'CheapShark', resultados });

    } catch (error) {
        console.error('Error en /api/buscar-juego:', error.message);
        res.status(500).json({
            exito: false,
            mensaje: 'No se pudo completar la búsqueda. Inténtalo de nuevo en un momento.'
        });
    }
});

// Comparativa de precios de un juego ya guardado (solo consulta MySQL)
app.get('/api/comparar/:id', async (req, res) => {
    const juegoIdInterno = req.params.id;

    try {
        const [juego] = await pool.query('SELECT id, titulo, imagen_url FROM juegos WHERE id = ?', [juegoIdInterno]);

        if (juego.length === 0) {
            return res.status(404).json({
                exito: false,
                mensaje: 'El juego no existe en la base de datos.'
            });
        }

        const queryPrecios = `
            SELECT
                t.nombre AS tienda,
                t.url_base AS enlace,
                p.precio_actual
            FROM precios p
            JOIN tiendas t ON p.tienda_id = t.id
            WHERE p.juego_id = ?
            ORDER BY p.precio_actual ASC;
        `;
        const [listaPrecios] = await pool.query(queryPrecios, [juegoIdInterno]);

        res.status(200).json({
            exito: true,
            juego: juego[0].titulo,
            portada: juego[0].imagen_url,
            mejor_precio: listaPrecios.length > 0 ? listaPrecios[0] : null,
            todas_las_ofertas: listaPrecios
        });

    } catch (error) {
        console.error('Error al generar la comparativa:', error.message);
        res.status(500).json({
            exito: false,
            mensaje: 'Error interno al consultar la base de datos.'
        });
    }
});

//ARRANQUE
const PORT = process.env.PORT || 3000;

prepararTiendas()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Servidor backend escuchando en http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('No se pudo preparar la base de datos:', err.message);
        process.exit(1);
    });