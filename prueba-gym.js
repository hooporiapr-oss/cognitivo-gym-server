// ══════════════════════════════════════════════════════════════════
//  THE GYM SERVER'S TESTS
//
//  Run with `node prueba-gym.js`. They need nothing: no database
//  standing up, no key, no internet. The database is a fake one and
//  it lives at the top of this file.
//
//  What is measured, in the order it would hurt to break:
//
//    1  that the board NEVER returns another player's code
//    2  that a worse score cannot wipe out a better one
//    3  that an invented number cannot get in
//    4  that the code brings a player back on another phone
//    5  that the board is earned by playing all four
//    6  that the domain list lets nobody else in
// ══════════════════════════════════════════════════════════════════
const http = require('http');
const { app, usarBase, nivelDePuntos, normalizar,
        JUEGOS, DOMINIOS, TECHO_PUNTOS } = require('./server.js');

let fallos = 0;
const ok  = (t) => console.log('  ok   ' + t);
const mal = (t) => { fallos++; console.log('  BAD  ' + t) };
const si  = (c, t) => c ? ok(t) : mal(t);
const eq  = (a, b, t) => JSON.stringify(a) === JSON.stringify(b)
  ? ok(t)
  : mal(t + ' → expected ' + JSON.stringify(b) + ' and got ' + JSON.stringify(a));

/* ── A FAKE DATABASE ──────────────────────────────────────────────
   Imitates just enough of Supabase's query builder: from, select,
   insert, update, eq, in, maybeSingle, and being awaitable. Nothing
   more, because the server uses nothing more.

   THE IMPORTANT PART: like the real one, it does NOTHING until
   somebody asks for the result. So a query the server fires and does
   not await behaves here the way it behaves on Render — which is
   exactly the bug that was hiding the 'visto' timestamp. */
function baseFalsa(semilla){
  const T = JSON.parse(JSON.stringify(semilla || {}));
  T.gym_equipos   = T.gym_equipos   || [];
  T.gym_jugadores = T.gym_jugadores || [];
  T.gym_marcas    = T.gym_marcas    || [];

  function consulta(tabla){
    const q = { _op: null, _row: null, _filtros: [] };

    const pasa = (f) => q._filtros.every(([c, v, modo]) =>
      modo === 'in' ? v.indexOf(f[c]) !== -1 : f[c] === v);

    function correr(){
      const filas = T[tabla];
      if (q._op === 'insert'){
        const r = q._row;
        /* The real primary keys: gym_jugadores by code, gym_marcas by
           code + game. Without this, the code-collision test would
           not be testing anything. */
        const choca = tabla === 'gym_jugadores'
          ? filas.some((f) => f.codigo === r.codigo)
          : tabla === 'gym_marcas'
            ? filas.some((f) => f.codigo === r.codigo && f.juego === r.juego)
            : filas.some((f) => f.id === r.id);
        if (choca) return { data: null, error: { code: '23505' } };
        if (tabla === 'gym_marcas' && (r.mejor < 0 || r.mejor > TECHO_PUNTOS))
          return { data: null, error: { code: '23514' } };   // the database's check
        filas.push(Object.assign({}, r));
        return { data: [r], error: null };
      }
      if (q._op === 'update'){
        let n = 0;
        for (const f of filas) if (pasa(f)){ Object.assign(f, q._row); n++ }
        return { data: null, error: null, count: n };
      }
      return { data: filas.filter(pasa).map((f) => Object.assign({}, f)), error: null };
    }

    q.select = function(){ q._op = 'select'; return q };
    q.insert = function(r){ q._op = 'insert'; q._row = r; return q };
    q.update = function(r){ q._op = 'update'; q._row = r; return q };
    q.eq = function(c, v){ q._filtros.push([c, v, 'eq']); return q };
    q.in = function(c, a){ q._filtros.push([c, a, 'in']); return q };
    q.maybeSingle = function(){
      const r = correr();
      return Promise.resolve({ data: (r.data && r.data[0]) || null, error: r.error });
    };
    q.then = function(res, rej){ return Promise.resolve(correr()).then(res, rej) };
    return q;
  }
  return { from: consulta, _tablas: T };
}

// ── A real server, on a spare port ────────────────────────────────
let servidor, PUERTO;
function pedir(ruta, cuerpo, origen){
  return new Promise((resolve) => {
    const datos = JSON.stringify(cuerpo || {});
    const cab = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) };
    if (origen) cab.Origin = origen;
    const r = http.request({ host: '127.0.0.1', port: PUERTO, path: ruta, method: 'POST', headers: cab },
      (res) => {
        let t = '';
        res.on('data', (c) => t += c);
        res.on('end', () => {
          let j = null; try { j = JSON.parse(t) } catch (e) {}
          resolve({ codigoHttp: res.statusCode, cuerpo: j, cabeceras: res.headers });
        });
      });
    r.on('error', () => resolve({ codigoHttp: 0, cuerpo: null, cabeceras: {} }));
    r.write(datos); r.end();
  });
}

(async () => {

console.log('\n0 · The points scale, out and back\n');
{
  /* The level is what the board draws, and it comes out of the
     points. If this inversion drifts, the whole picture lies. */
  const ida = (L) => L * (L + 1) / 2;
  let bien = true;
  for (let L = 0; L <= 25; L++) if (nivelDePuntos(ida(L)) !== L) bien = false;
  si(bien, 'from level 0 to 25, points come back to their exact level');
  eq(nivelDePuntos(325), 25, 'the 5x5 ceiling is level 25');
  eq(nivelDePuntos(0), 0, 'no points, no level');
  si(JUEGOS.length === 4, 'and the gym has four games');
}

console.log('\n1 · A code typed badly still gets in\n');
{
  eq(normalizar('acd-efg'), 'ACD-EFG', 'in lower case');
  eq(normalizar('acd efg'), 'ACD-EFG', 'with a space instead of the hyphen');
  eq(normalizar('ACDEFG'),  'ACD-EFG', 'all run together');
  eq(normalizar(' acd-efg '), 'ACD-EFG', 'with spaces around it');
  si(normalizar('ACD-EF')  === null, 'five letters is not a code');
  si(normalizar('ACD-EFGH')=== null, 'nor is seven');
  /* The letters taken out of the alphabet were taken out for a
     reason: accepted, "0" and "O" would be two different codes that
     look the same written on a slip of paper. */
  si(normalizar('ACD-EF0') === null, 'and a zero is not a letter of the alphabet');
  si(normalizar('ACD-EFO') === null, 'nor is the letter O');
  si(normalizar('') === null && normalizar(null) === null, 'nor is nothing');
}

// ── From here on, the server is up ────────────────────────────────
await new Promise((r) => { servidor = app.listen(0, () => { PUERTO = servidor.address().port; r() }) });

console.log('\n2 · The first play issues a code\n');
let CODIGO = null;
{
  usarBase(baseFalsa({ gym_equipos: [{ id: 'paradiso-6', nombre: 'Paradiso 6th' }] }));
  const r = await pedir('/jugador', { equipo: 'paradiso-6' });
  si(r.codigoHttp === 200 && r.cuerpo && r.cuerpo.ok, 'it answers');
  CODIGO = r.cuerpo && r.cuerpo.codigo;
  si(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(CODIGO || ''), 'with a three-and-three code: ' + CODIGO);
  eq(r.cuerpo.equipo, 'paradiso-6', 'and on the team from the link');

  /* A MISTYPED LINK LEAVES NOBODY OUT. The team does not exist, the
     player is created anyway, without one. */
  const s = await pedir('/jugador', { equipo: 'no-such-team' });
  si(s.codigoHttp === 200 && s.cuerpo.ok, 'a team that does not exist does not stop the play');
  eq(s.cuerpo.equipo, null, 'the player ends up with no team, and plays');

  const t = await pedir('/jugador', {});
  si(t.codigoHttp === 200 && t.cuerpo.ok, 'and with no team at all you can still come in');
  si(t.cuerpo.codigo !== CODIGO, 'and everyone leaves with their own');
}

console.log('\n3 · The score: the best one stays, and it only goes up\n');
{
  const base = baseFalsa({
    gym_equipos: [{ id: 'eq', nombre: 'Team' }],
    gym_jugadores: [{ codigo: 'ACD-EFG', equipo: 'eq' }]
  });
  usarBase(base);

  const uno = await pedir('/anotar', { codigo: 'ACD-EFG', juego: 'recall', puntos: 21 });
  eq([uno.cuerpo.mejor, uno.cuerpo.nivel, uno.cuerpo.record], [21, 6, true],
     'the first score goes in: 21 points, level 6, and it is a record');

  /* THE HANDBRAKE. Two scores in a row from the same code are
     refused, and the test has to wait before it can go on measuring
     the real thing. */
  const rapida = await pedir('/anotar', { codigo: 'ACD-EFG', juego: 'recall', puntos: 28 });
  eq(rapida.codigoHttp, 429, 'two scores in the same second: the second is held');
  await new Promise((r) => setTimeout(r, 2100));

  const peor = await pedir('/anotar', { codigo: 'ACD-EFG', juego: 'recall', puntos: 6 });
  eq([peor.cuerpo.mejor, peor.cuerpo.record], [21, false],
     'a WORSE score does not wipe out the good one, and is not celebrated');
  await new Promise((r) => setTimeout(r, 2100));

  const mejor = await pedir('/anotar', { codigo: 'ACD-EFG', juego: 'recall', puntos: 36 });
  eq([mejor.cuerpo.mejor, mejor.cuerpo.nivel, mejor.cuerpo.record], [36, 8, true],
     'a better one does replace it');

  const fila = base._tablas.gym_marcas.find((f) => f.juego === 'recall');
  eq(fila.intentos, 3, 'and the attempts are counted without a row per round');
  eq(base._tablas.gym_marcas.length, 1,
     'three rounds of the same game are ONE row, not three');

  /* The 'visto' stamp is the one that was fired without being
     awaited and never actually went out. If that regresses, this
     catches it. */
  si(!!base._tablas.gym_jugadores[0].visto,
     'and the last-seen stamp gets written, even though it is not awaited');
}

console.log('\n4 · What does not get in\n');
{
  const base = baseFalsa({ gym_jugadores: [{ codigo: 'ACD-EFG', equipo: null }] });
  usarBase(base);
  const casos = [
    [{ codigo: 'ACD-EFG', juego: 'recall', puntos: 326 }, 400, 'one point over the 5x5 ceiling'],
    [{ codigo: 'ACD-EFG', juego: 'recall', puntos: 99999 }, 400, 'an invented number'],
    [{ codigo: 'ACD-EFG', juego: 'recall', puntos: -1 }, 400, 'a negative'],
    [{ codigo: 'ACD-EFG', juego: 'recall', puntos: 'lots' }, 400, 'something that is not a number'],
    [{ codigo: 'ACD-EFG', juego: 'chess', puntos: 10 }, 400, 'a game that is not the gym\'s'],
    [{ codigo: 'XXX-XXX', juego: 'recall', puntos: 10 }, 404, 'a code that does not exist'],
    [{ codigo: 'nope', juego: 'recall', puntos: 10 }, 400, 'a code with a bad shape']
  ];
  for (const [cuerpo, esperado, texto] of casos){
    const r = await pedir('/anotar', cuerpo);
    si(r.codigoHttp === esperado, texto + ' → ' + r.codigoHttp);
    await new Promise((r2) => setTimeout(r2, 5));
  }
  eq(base._tablas.gym_marcas.length, 0, 'and not one score was left behind by any of it');
}

console.log('\n5 · The board returns not one code that is not yours\n');
{
  usarBase(baseFalsa({
    gym_equipos: [{ id: 'eq', nombre: 'Paradiso 6th' }],
    gym_jugadores: [
      { codigo: 'ACD-EFG', equipo: 'eq' },
      { codigo: 'HJK-MNP', equipo: 'eq' },
      { codigo: 'QRT-UVW', equipo: 'eq' },
      { codigo: 'XY3-467', equipo: 'other' }
    ],
    gym_marcas: [
      { codigo: 'ACD-EFG', juego: 'recall', mejor: 21, intentos: 2 },
      { codigo: 'HJK-MNP', juego: 'recall', mejor: 36, intentos: 1 },
      { codigo: 'QRT-UVW', juego: 'recall', mejor: 10, intentos: 1 },
      { codigo: 'XY3-467', juego: 'recall', mejor: 325, intentos: 9 },
      { codigo: 'ACD-EFG', juego: 'fortress', mejor: 15, intentos: 1 }
    ]
  }));

  const r = await pedir('/tablero', { codigo: 'acd efg' });
  si(r.codigoHttp === 200 && r.cuerpo.ok, 'it answers, and accepts the badly typed code');

  /* THE MOST IMPORTANT CHECK IN THIS FILE. The whole JSON is read
     raw: if any other player's code comes out of here, the board
     could draw it, and the board belongs to kids. */
  const crudo = JSON.stringify(r.cuerpo);
  const ajenos = ['HJK-MNP', 'QRT-UVW', 'XY3-467'].filter((c) => crudo.indexOf(c) !== -1);
  eq(ajenos, [], 'and in the whole JSON there is not one code belonging to somebody else');
  si(crudo.indexOf('ACD-EFG') !== -1, 'the player\'s own is there, since he is the one asking');

  const recall = r.cuerpo.juegos.find((j) => j.juego === 'recall');
  eq(recall.mio, 21, 'my score comes separately, so it can be lit up');
  eq(recall.nivelMio, 6, 'with its level');
  eq(recall.equipo.slice().sort((a, b) => a - b), [10, 21, 36],
     'the team\'s come as loose numbers: all three, mine included');
  si(recall.equipo.indexOf(325) === -1, 'and the kid from ANOTHER team is not in the list');
  eq(recall.mejorGym, 325, 'but the gym record is, since that belongs to everyone');
  eq(recall.nivelGym, 25, 'with its level');

  const fortress = r.cuerpo.juegos.find((j) => j.juego === 'fortress');
  eq(fortress.mio, 15, 'a game only I have played shows my score');
  eq(fortress.equipo, [15], 'and the team is just me');

  const replay = r.cuerpo.juegos.find((j) => j.juego === 'replay');
  eq([replay.mio, replay.equipo, replay.mejorGym], [0, [], 0],
     'and one nobody has played comes back at zero, it does not fall over');

  eq(r.cuerpo.juegos.map((j) => j.juego),
     ['recall', 'recognition', 'replay', 'fortress'],
     'the four come in the hub\'s order, which is the drawing\'s order');
  eq(r.cuerpo.equipo, { id: 'eq', nombre: 'Paradiso 6th' },
     'the only name that travels is the team\'s');
  eq(r.cuerpo.escala, 25, 'and the drawing\'s scale is the 5x5 ceiling');

  /* This player has recall and fortress, and is two short. */
  eq(r.cuerpo.completo, false, 'with two games of four, the board is not open');
  eq(r.cuerpo.faltan, ['recognition', 'replay'], 'and it says which are missing, in order');
}

console.log('\n5b · The lock: all four, and it opens\n');
{
  const cuatro = ['recall', 'recognition', 'replay', 'fortress'];
  usarBase(baseFalsa({
    gym_jugadores: [{ codigo: 'ACD-EFG', equipo: null }],
    gym_marcas: cuatro.map((j) => ({ codigo: 'ACD-EFG', juego: j, mejor: 10, intentos: 1 }))
  }));
  let r = await pedir('/tablero', { codigo: 'ACD-EFG' });
  eq([r.cuerpo.completo, r.cuerpo.faltan], [true, []], 'with all four played, it opens');

  /* THE ONE THAT MATTERS. A kid who finishes the warm-up and blanks
     one station played all four: his row exists with zero points. If
     the lock looked at the POINTS instead of the row, that kid would
     be shut out by the station he is worst at — which is exactly the
     kid who most needs to see himself climbing. */
  usarBase(baseFalsa({
    gym_jugadores: [{ codigo: 'ACD-EFG', equipo: null }],
    gym_marcas: cuatro.map((j) => ({
      codigo: 'ACD-EFG', juego: j, mejor: (j === 'replay' ? 0 : 10), intentos: 1
    }))
  }));
  r = await pedir('/tablero', { codigo: 'ACD-EFG' });
  eq(r.cuerpo.completo, true, 'and a zero at one station does NOT shut the board: he played it');
  const replay = r.cuerpo.juegos.find((j) => j.juego === 'replay');
  eq([replay.jugado, replay.mio], [true, 0], 'that game comes back played and at zero, both');

  /* And a score of zero has to be able to get in, or the case above
     never happens in real life.

     WITH ANOTHER CODE, not the one above: the handbrake is per code
     and lasts two seconds, and ACD-EFG has been scoring since section
     3. With it, this would return 429 and look as though the server
     refuses a zero — which is the opposite of what happens. */
  usarBase(baseFalsa({ gym_jugadores: [{ codigo: 'HJK-MNP', equipo: null }] }));
  const cero = await pedir('/anotar', { codigo: 'HJK-MNP', juego: 'replay', puntos: 0 });
  si(cero.codigoHttp === 200 && cero.cuerpo.ok, 'a score of zero points is stored all the same');
  eq(cero.cuerpo.nivel, 0, 'at level zero');
}

console.log('\n6 · The first day, and the player with no team\n');
{
  usarBase(baseFalsa({
    gym_jugadores: [{ codigo: 'ACD-EFG', equipo: null }],
    gym_marcas: [{ codigo: 'ACD-EFG', juego: 'recall', mejor: 1, intentos: 1 }]
  }));
  const r = await pedir('/tablero', { codigo: 'ACD-EFG' });
  eq(r.cuerpo.equipo, null, 'with no team, the board does not invent one');
  const recall = r.cuerpo.juegos.find((j) => j.juego === 'recall');
  eq(recall.equipo, [], 'and the team list comes back empty');
  eq(recall.mio, 1, 'but his score is there');
  /* THE SCALE DOES NOT MOVE. One player at level 1, alone, with no
     record anywhere, and the scale is still 25 — he is near the
     middle because he IS near the middle. */
  eq(r.cuerpo.escala, 25, 'and the scale is the same 25 it is for everybody else');
}

console.log('\n6b · And the scale never moves, whoever plays\n');
{
  /* THE FAILURE THIS REPLACED. With the scale set to the best level
     around, a player's own arc moved backwards whenever somebody else
     improved: at 6 of 11 he sat a bit past halfway, and the day
     another player reached 20 the same score sat at 6 of 20. Nothing
     he did changed, and his board shrank.

     So: same player, same score, two very different gyms around him,
     and the scale has to come back identical both times. */
  const suyo = [{ codigo: 'ACD-EFG', juego: 'recall', mejor: 21, intentos: 1 }];

  usarBase(baseFalsa({
    gym_jugadores: [{ codigo: 'ACD-EFG', equipo: null }],
    gym_marcas: suyo
  }));
  const solo = await pedir('/tablero', { codigo: 'ACD-EFG' });

  usarBase(baseFalsa({
    gym_jugadores: [{ codigo: 'ACD-EFG', equipo: null },
                    { codigo: 'HJK-MNP', equipo: null }],
    gym_marcas: suyo.concat([{ codigo: 'HJK-MNP', juego: 'recall', mejor: 325, intentos: 9 }])
  }));
  const conFenomeno = await pedir('/tablero', { codigo: 'ACD-EFG' });

  eq([solo.cuerpo.escala, conFenomeno.cuerpo.escala], [25, 25],
     'alone or beside somebody at the ceiling, the scale is 25 both times');
  eq([solo.cuerpo.juegos[0].nivelMio, conFenomeno.cuerpo.juegos[0].nivelMio], [6, 6],
     'and his own level is untouched by what anybody else did');
  /* The record still moves, which is the point: the line to reach
     comes closer or further, the player's own arc does not. */
  eq([solo.cuerpo.juegos[0].nivelGym, conFenomeno.cuerpo.juegos[0].nivelGym], [6, 25],
     'what changes is the record — the line to reach, not where he stands');
}

console.log('\n7 · The domain list\n');
{
  const pasa = (o) => DOMINIOS.test(o) || /^https?:\/\/localhost(:\d+)?$/.test(o);
  for (const o of ['https://hooporia.mobi', 'https://www.hooporia.mobi',
                   'http://localhost:8080']) si(pasa(o), o);

  /* THE LIST ONLY EVER HOLDS DOMAINS WE SERVE FROM TODAY.

     This used to assert that cognitivo.digital and cognitivogym.com
     were accepted. Both came out on 26 October 2026, for the same
     reason and it is worth writing down:

       · cognitivo.digital was the main site for one day, the 25th,
         and moved back to cadapunto.com on the 26th. Nothing is
         served from it any more.
       · cognitivogym.com was never registered. It sat here waiting
         for the day it would be.

     A retired name and an unregistered one are the same open door:
     whoever registers it can call this server from their pages. A
     domain earns its line the day it is pointed, not before and not
     after. */
  for (const [o, t] of [
    ['', 'no origin at all'],
    ['https://hooporia.mobi.attacker.net', 'one that STARTS with ours'],
    ['https://mihooporia.mobi', 'ours with something stuck on the front'],
    ['https://hooporia.com', 'the .com, which is the retired domain'],
    ['https://cognitivo.digital', 'the domain that lasted one day'],
    ['https://cognitivogym.com', 'and one nobody has registered yet'],
    ['https://cognitivo.com', 'cognitivo with another ending'],
    ['http://hooporia.mobi', 'ours without encryption'],
    ['https://evil.com', 'any old one']
  ]) si(!pasa(o), t + (o ? ' (' + o + ')' : ''));

  /* And that the header returns the origin and not a wildcard. */
  const r = await pedir('/tablero', { codigo: 'nope' }, 'https://hooporia.mobi');
  eq(r.cabeceras['access-control-allow-origin'], 'https://hooporia.mobi',
     'the origin that asked is returned, already checked');
  const s = await pedir('/tablero', { codigo: 'nope' }, 'https://evil.com');
  si(!s.cabeceras['access-control-allow-origin'],
     'and whoever is not on the list gets none back');
}

console.log('\n8 · With no database configured it does not fall over, it says so\n');
{
  usarBase(null);
  for (const ruta of ['/jugador', '/anotar', '/tablero']){
    const r = await pedir(ruta, { codigo: 'ACD-EFG', juego: 'recall', puntos: 10 });
    si(r.codigoHttp === 503 && r.cuerpo && r.cuerpo.error === 'base-sin-configurar',
       ruta + ' answers 503 and says why');
  }
}

servidor.close();
console.log('\n' + (fallos === 0
  ? 'OK — the gym keeps scores, not names, and lets no invented number in'
  : 'FAILED — ' + fallos + ' problem(s)') + '\n');
process.exit(fallos === 0 ? 0 : 1);

})();
