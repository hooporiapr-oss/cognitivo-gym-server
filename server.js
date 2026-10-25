// ══════════════════════════════════════════════════════════════════
//  THE GYM SERVER
//
//  The four games on the mobile gym kept nothing. You played, a number
//  came up on the screen, and closing the page took the number with
//  it. This is what keeps that number, and what the board reads to
//  show a kid where he stands.
//
//  Three routes, and none of them belongs to the pledge side:
//
//    POST /jugador   issues a code on the first play. With a team, the
//                    player joins that team.
//    POST /anotar    stores a score, if it beats the one already there
//    POST /tablero   the four games: the player's own mark, his team's
//                    marks with no names, and the gym record
//
//  ── WHY THIS IS NOT IN hooporia-server ───────────────────────────
//  Because the gym has nothing to do with pledges or fundraising.
//  That server holds Stripe, invoices and emails to padrinos; a change
//  made for a kid's score has no business being able to break an
//  invoice, and the reverse. Two products, two services.
//
//  ── EVERY ROUTE IS POST, including the one that only reads ────────
//  The code IS the player's identity: with it you can post a score in
//  his name. In a GET it would sit in the address bar, and from there
//  it reaches the server log, the phone's history, and the Referer
//  header of anything the page loads afterwards. In a POST body it
//  reaches none of the three.
//
//  ── WHAT IS NOT STORED ───────────────────────────────────────────
//  A kid's name. No email, no phone, no age, no school. A player here
//  is a code, a team and four numbers. The board has no names because
//  the database has none.
//
//  ── Environment variables ────────────────────────────────────────
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//    PORT                       set by Render
// ══════════════════════════════════════════════════════════════════
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();

/* The database can be swapped for a fake one. It is the only thing
   this file does differently from the pledge server, and it is
   deliberate: the tests over there stand up a real Postgres on a
   socket, which tied running the tests to having a database. These
   run with `node prueba-gym.js` and nothing else. */
let base = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
function usarBase(otra){ base = otra }

app.use(express.json({ limit: '8kb' }));

/* ── Where calls are accepted from ────────────────────────────────
   The mobile gym lives at hooporia.mobi and the main site at
   cognitivo.digital. Both, because the board opens from the mobile
   hub and also from the front page.

   ANCHORED, and each ending on its own. The pledge server's list
   broke twice on domain moves, silently both times: CORS gives no
   error anyone can read — the browser blocks the response by itself
   and the page just waits. A pattern with no ^ or $ accepts
   hooporia.mobi.attacker.net, and folding cognitivo into the .com
   group would accept cognitivo.com, which is not ours.

   When cognitivogym.com is registered, it gets added HERE, the same
   day the domain is pointed. This line is the second commit of every
   move, and it is the one that gets forgotten. */
const DOMINIOS = /^https:\/\/(www\.)?(hooporia\.mobi|cognitivo\.digital|cognitivogym\.com)$/;
app.use((req, res, next) => {
  const o = req.headers.origin || '';
  if (DOMINIOS.test(o) || /^https?:\/\/localhost(:\d+)?$/.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── The four games, and nothing else ──────────────────────────────
/* The order is the hub's and the warm-up's: Q1 through Q4. The board
   draws its quadrants in this order, so changing it here moves the
   picture. */
const JUEGOS = [
  { id: 'recall',      nombre: 'THE RECALL' },
  { id: 'recognition', nombre: 'THE RECOGNITION' },
  { id: 'replay',      nombre: 'THE REPLAY' },
  { id: 'fortress',    nombre: 'THE FORTRESS' }
];
const ES_JUEGO = (j) => JUEGOS.some((x) => x.id === j);

/* ── Points and levels ────────────────────────────────────────────
   All four games score the same way: a chain of level L is worth
   L(L+1)/2, and a game keeps the BEST chain, not the sum. So the
   level comes back out of the points, and the level is what the board
   draws: "I got to 6" explains itself, "I got 21" does not.

   This is the same inversion nivelDePuntos() does in fortress-vr.html.
   If the scale ever changes, it changes in both places. */
const NIVEL_TECHO  = 25;             // every cell of the 5x5
const TECHO_PUNTOS = 325;            // the triangular of 25, the whole 5x5
function nivelDePuntos(p){
  p = parseInt(p, 10) || 0;
  if (p <= 0) return 0;
  return Math.round((-1 + Math.sqrt(1 + 8 * p)) / 2);
}

/* ── The code ─────────────────────────────────────────────────────
   A kid is going to type this on a phone, and read it off a slip of
   paper or another screen. So everything confusable is out: 0 and O,
   1 and I and L, 5 and S, 2 and Z, 8 and B. That leaves 25 letters
   over six positions: 244 million, which is plenty for a gym.

   Hyphenated in the middle because six characters in a row get typed
   wrong; the server puts the hyphen in and the input accepts it with
   or without. */
const ALFABETO = 'ACDEFGHJKMNPQRTUVWXY34679';
function nuevoCodigo(){
  let s = '';
  for (let i = 0; i < 6; i++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return s.slice(0, 3) + '-' + s.slice(3);
}
/* Whatever arrives from the phone is normalised before it is looked
   up: upper case, no spaces, hyphen where it belongs. A kid who types
   "acd efg" in lower case has to get in all the same. */
function normalizar(c){
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 6) return null;
  for (const ch of s) if (ALFABETO.indexOf(ch) === -1) return null;
  return s.slice(0, 3) + '-' + s.slice(3);
}

/* ── A handbrake ──────────────────────────────────────────────────
   A game stuck in a loop, or a jammed finger, can send a hundred
   scores a second. It does the data no harm — the best one wins — but
   it does the database bill plenty. Two seconds between scores from
   the same code is longer than any round takes.

   In memory, and lost on restart, deliberately: this is not security,
   it is courtesy to the database, and it does not deserve a row
   anywhere. */
const ULTIMA = new Map();
const FRENO_MS = 2000;
function muySeguido(codigo){
  const ahora = Date.now();
  const antes = ULTIMA.get(codigo) || 0;
  if (ahora - antes < FRENO_MS) return true;
  ULTIMA.set(codigo, ahora);
  if (ULTIMA.size > 5000) ULTIMA.clear();   // does not grow forever
  return false;
}

const sinBase = (res) =>
  res.status(503).json({ ok: false, error: 'base-sin-configurar' });

// ══════════════════════════════════════════════════════════════════
//  POST /jugador — the code from the first play
// ══════════════════════════════════════════════════════════════════
/* The team comes from the LINK the coach hands out
   (…/tablero-gym.html?e=paradiso-6), not from anything a kid types.
   That way the first play asks for nothing: it is issued as the first
   score is posted.

   A team that does not exist is NOT an error that stops anything: the
   player is created without a team and plays all the same. A
   mistyped link cannot leave a kid out of the gym. */
app.post('/jugador', async (req, res) => {
  if (!base) return sinBase(res);
  const pedido = String((req.body && req.body.equipo) || '').trim().toLowerCase();
  let equipo = null;

  if (pedido && /^[a-z0-9-]{1,40}$/.test(pedido)) {
    const { data } = await base.from('gym_equipos').select('id').eq('id', pedido).maybeSingle();
    if (data) equipo = data.id;
  }

  /* Six tries before giving up. With 244 million codes and one gym
     the second try is never going to be needed; it is here because a
     silent collision would hand two kids the same code, and one of
     them would be looking at the other's board. */
  for (let i = 0; i < 6; i++) {
    const codigo = nuevoCodigo();
    const { error } = await base.from('gym_jugadores')
      .insert({ codigo: codigo, equipo: equipo, visto: new Date().toISOString() });
    if (!error) return res.json({ ok: true, codigo: codigo, equipo: equipo });
    if (error.code !== '23505') {            // 23505 = already exists
      return res.status(500).json({ ok: false, error: 'no-se-pudo-crear' });
    }
  }
  return res.status(500).json({ ok: false, error: 'sin-codigo-libre' });
});

// ══════════════════════════════════════════════════════════════════
//  POST /anotar — the best one stays
// ══════════════════════════════════════════════════════════════════
/* READ, COMPARE, WRITE, in three steps and not one. An increment of
   'intentos' can be lost if the same kid sends two scores in the same
   millisecond, and that is accepted: 'intentos' is a curiosity, and
   'mejor' cannot be lost because it only goes up.

   What is NOT accepted is a worse score wiping out a better one, and
   that is what the Math.max is for. */
app.post('/anotar', async (req, res) => {
  if (!base) return sinBase(res);
  const b = req.body || {};
  const codigo = normalizar(b.codigo);
  const juego = String(b.juego || '').toLowerCase();
  const puntos = parseInt(b.puntos, 10);

  if (!codigo) return res.status(400).json({ ok: false, error: 'codigo-malo' });
  if (!ES_JUEGO(juego)) return res.status(400).json({ ok: false, error: 'juego-malo' });
  /* The ceiling is checked here and again in the database. A number
     above 325 does not come out of a 5x5 board: it comes out of
     somebody editing the page, and one invented record takes the
     meaning out of everybody else's board. */
  if (!Number.isFinite(puntos) || puntos < 0 || puntos > TECHO_PUNTOS) {
    return res.status(400).json({ ok: false, error: 'puntos-fuera-de-rango' });
  }
  if (muySeguido(codigo)) return res.status(429).json({ ok: false, error: 'muy-seguido' });

  const { data: quien } = await base.from('gym_jugadores')
    .select('codigo').eq('codigo', codigo).maybeSingle();
  if (!quien) return res.status(404).json({ ok: false, error: 'codigo-no-existe' });

  const { data: habia } = await base.from('gym_marcas')
    .select('mejor, intentos').eq('codigo', codigo).eq('juego', juego).maybeSingle();

  const antes = habia ? (habia.intentos || 0) : 0;
  const mejorAntes = habia ? (habia.mejor || 0) : 0;
  const mejor = Math.max(mejorAntes, puntos);
  const fila = {
    codigo: codigo, juego: juego, mejor: mejor,
    intentos: antes + 1, actualizado: new Date().toISOString()
  };

  const { error } = habia
    ? await base.from('gym_marcas').update(fila).eq('codigo', codigo).eq('juego', juego)
    : await base.from('gym_marcas').insert(fila);
  if (error) return res.status(500).json({ ok: false, error: 'no-se-pudo-anotar' });

  /* NOT AWAITED, but actually fired. A Supabase query builder sends
     nothing until somebody asks for the result: written as
     `base.from(...).update(...)` and no more, this would never have
     left the process. The empty .then() is what sends it.

     It is not awaited because nobody cares when the last-seen stamp
     gets written, and awaiting it adds a database round trip to every
     score. If it fails, that date is lost and nothing else is — which
     is why it carries its own catch and never touches the reply. */
  base.from('gym_jugadores').update({ visto: fila.actualizado })
      .eq('codigo', codigo).then(function(){}, function(){});

  return res.json({
    ok: true,
    mejor: mejor,
    nivel: nivelDePuntos(mejor),
    record: puntos > mejorAntes          // so the page can celebrate it
  });
});

// ══════════════════════════════════════════════════════════════════
//  POST /tablero — the four games
// ══════════════════════════════════════════════════════════════════
/* NOTHING THAT LEAVES HERE CARRIES SOMEBODY ELSE'S CODE. The team's
   marks go out as a loose, shuffled list of numbers: no code, no
   order, nothing tying a number to a kid. The board cannot show names
   because it never receives any.

   The player's own goes separately, in 'mio', which is all the page
   needs in order to light it up.

   On a team of two, whoever is looking knows the other number is the
   other kid's. That happens to any two-person league table and has no
   fix; what does have a fix is whether a name sits next to it, and
   none does. */
app.post('/tablero', async (req, res) => {
  if (!base) return sinBase(res);
  const codigo = normalizar((req.body || {}).codigo);
  if (!codigo) return res.status(400).json({ ok: false, error: 'codigo-malo' });

  const { data: quien } = await base.from('gym_jugadores')
    .select('codigo, equipo').eq('codigo', codigo).maybeSingle();
  if (!quien) return res.status(404).json({ ok: false, error: 'codigo-no-existe' });

  /* Mine, my team's, and each game's record.

     'intentos' comes along with 'mejor' because the board is earned by
     having PLAYED all four, not by having scored in all four. A kid
     who finishes the warm-up and blanks one station did the whole
     piece of work: his row exists with 0 points, and shutting him out
     for that would be punishing him for the station he is worst at.
     What opens the board is the row existing. */
  const { data: mias } = await base.from('gym_marcas')
    .select('juego, mejor, intentos').eq('codigo', codigo);

  let companeros = [];
  let equipo = null;
  if (quien.equipo) {
    const { data: eq } = await base.from('gym_equipos')
      .select('id, nombre').eq('id', quien.equipo).maybeSingle();
    if (eq) equipo = { id: eq.id, nombre: eq.nombre };

    const { data: gente } = await base.from('gym_jugadores')
      .select('codigo').eq('equipo', quien.equipo);
    const codigos = (gente || []).map((g) => g.codigo);
    if (codigos.length) {
      const { data: m } = await base.from('gym_marcas')
        .select('juego, mejor').in('codigo', codigos);
      companeros = m || [];
    }
  }

  const { data: records } = await base.from('gym_marcas').select('juego, mejor');

  const mejorDe = (filas, juego) =>
    (filas || []).filter((f) => f.juego === juego)
                 .reduce((a, f) => Math.max(a, f.mejor || 0), 0);

  const juegos = JUEGOS.map((j) => {
    const mio = mejorDe(mias, j.id);
    const jugado = (mias || []).some((f) => f.juego === j.id);
    /* Shuffled. Sorted high to low, the first number in the list
       would always be the same kid across all four games, and that is
       where guessing who is who begins. */
    const delEquipo = (companeros || [])
      .filter((f) => f.juego === j.id && (f.mejor || 0) > 0)
      .map((f) => f.mejor);
    for (let i = delEquipo.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      const t = delEquipo[i]; delEquipo[i] = delEquipo[k]; delEquipo[k] = t;
    }
    const gym = mejorDe(records, j.id);
    return {
      juego: j.id,
      nombre: j.nombre,
      jugado: jugado,
      mio: mio,
      nivelMio: nivelDePuntos(mio),
      equipo: delEquipo,
      nivelesEquipo: delEquipo.map(nivelDePuntos),
      mejorGym: gym,
      nivelGym: nivelDePuntos(gym)
    };
  });

  /* The drawing's scale, shared by all four quadrants: without it a
     level 4 in one game would look higher than a 7 next to it,
     because each quadrant would have stretched to its own range.

     FIXED AT THE BOARD'S CEILING, and not at the highest level anyone
     has reached. It used to be the latter, and that made a kid's own
     arc move BACKWARDS when somebody else improved: at level 6 he was
     6/11 of the way out, and the day another player hit 20 he was
     6/20 — his board visibly shrank without him playing a bad round.
     On an open team where everyone piles onto one record, that would
     have happened within a week.

     25 is not an arbitrary number: it is every cell of the 5x5, which
     is the longest chain the board can hold, and 325 points. So a
     full ring means a finished board and nothing on screen ever moves
     except by playing.

     The cost is honest and worth paying: early on everything sits
     close to the middle, because level 6 of 25 really is a quarter of
     the way. A scale that flattered the first week by stretching to
     fit would have to take it back later. */
  const escala = NIVEL_TECHO;

  /* ── THE KEY TO THE BOARD ────────────────────────────────────────
     The board is earned by playing all four. The server decides it,
     not the page, for two reasons: a flag in localStorage is changed
     from the phone in ten seconds, and — the one that matters more —
     the lock has to travel with the code. A kid who finished the four
     on the class phone opens his board at home, and one who did not
     opens it nowhere.

     Both go out: 'completo' for the lock and 'faltan' so the page can
     say WHAT is missing, which is the difference between a shut door
     and a direction. */
  const faltan = juegos.filter((j) => !j.jugado).map((j) => j.juego);

  return res.json({
    ok: true,
    codigo: codigo,
    equipo: equipo,
    escala: escala,
    completo: faltan.length === 0,
    faltan: faltan,
    juegos: juegos
  });
});

// ── Health ────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.send('Cognitivo Gym server — scores for the four games. No names and no money.'));

app.get('/estado', (req, res) => {
  const puesta = (n) => !!(process.env[n] || '').trim();
  res.json({
    ok: true,
    base: !!base,
    juegos: JUEGOS.map((j) => j.id),
    variables: {
      SUPABASE_URL: puesta('SUPABASE_URL'),
      SUPABASE_SERVICE_ROLE_KEY: puesta('SUPABASE_SERVICE_ROLE_KEY')
    }
  });
});

/* Only listens when it is actually run. Required from a test, it
   opens no port. */
if (require.main === module) {
  const PUERTO = process.env.PORT || 3000;
  app.listen(PUERTO, () => console.log('gym server on ' + PUERTO));
}

module.exports = { app, usarBase, nivelDePuntos, normalizar, nuevoCodigo,
                   JUEGOS, DOMINIOS, TECHO_PUNTOS, NIVEL_TECHO };
