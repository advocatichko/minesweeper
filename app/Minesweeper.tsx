'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

type Cell = {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  count: number;
};

const LEVELS = {
  easy:   { rows: 9,  cols: 9,  mines: 10 },
  medium: { rows: 16, cols: 16, mines: 40 },
  hard:   { rows: 16, cols: 30, mines: 99 },
  replay: { rows: 9,  cols: 9,  mines: 10 },
} as const;

type LevelName  = keyof typeof LEVELS;
type GameStatus = 'idle' | 'playing' | 'won' | 'lost';
type Theme      = 'system' | 'light' | 'dark';

// ── Board helpers ──────────────────────────────────────────────────────────

function createBoard(rows: number, cols: number, mines: number): Cell[][] {
  const b: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ mine: false, revealed: false, flagged: false, count: 0 }))
  );
  let placed = 0;
  while (placed < mines) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    if (!b[r][c].mine) { b[r][c].mine = true; placed++; }
  }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (b[r][c].mine) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && b[nr][nc].mine) n++;
        }
      b[r][c].count = n;
    }
  return b;
}

function revealCascade(board: Cell[][], r: number, c: number): void {
  const rows = board.length, cols = board[0].length;
  const stack: [number, number][] = [[r, c]];
  while (stack.length) {
    const [cr, cc] = stack.pop()!;
    const cell = board[cr][cc];
    if (cell.revealed || cell.flagged) continue;
    cell.revealed = true;
    if (cell.count === 0 && !cell.mine)
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = cr + dr, nc = cc + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !board[nr][nc].revealed)
            stack.push([nr, nc]);
        }
  }
}

function checkWin(board: Cell[][]): boolean {
  for (const row of board) for (const c of row) if (!c.revealed && !c.mine) return false;
  return true;
}

function createBoardFromPositions(rows: number, cols: number, minePositions: [number, number][]): Cell[][] {
  const b: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ mine: false, revealed: false, flagged: false, count: 0 }))
  );
  for (const [r, c] of minePositions) {
    if (r >= 0 && r < rows && c >= 0 && c < cols) b[r][c].mine = true;
  }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (b[r][c].mine) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && b[nr][nc].mine) n++;
        }
      b[r][c].count = n;
    }
  return b;
}

// Compact URL-safe encoding: 6-byte header (rows, cols, mines BE u16 each)
// + ceil(rows*cols/8) bytes for mine bitmask (bit 0 of byte 0 = cell (0,0)).
// Base64 alphabet replaced: + → -, / → _, = padding stripped.
function encodeBoard(rows: number, cols: number, mines: number, minePositions: [number, number][]): string {
  const bitBytes = Math.ceil((rows * cols) / 8);
  const buf = new Uint8Array(6 + bitBytes);
  buf[0] = (rows >> 8) & 0xff;  buf[1] = rows & 0xff;
  buf[2] = (cols >> 8) & 0xff;  buf[3] = cols & 0xff;
  buf[4] = (mines >> 8) & 0xff; buf[5] = mines & 0xff;
  for (const [r, c] of minePositions) {
    const bit = r * cols + c;
    buf[6 + (bit >> 3)] |= (1 << (7 - (bit & 7)));
  }
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBoard(id: string): { rows: number; cols: number; mines: number; minePositions: [number, number][] } | null {
  try {
    const bin = atob(id.replace(/-/g, '+').replace(/_/g, '/'));
    if (bin.length < 6) return null;
    const rows  = (bin.charCodeAt(0) << 8) | bin.charCodeAt(1);
    const cols  = (bin.charCodeAt(2) << 8) | bin.charCodeAt(3);
    const mines = (bin.charCodeAt(4) << 8) | bin.charCodeAt(5);
    if (!Number.isFinite(rows) || !Number.isFinite(cols) || !Number.isFinite(mines)) return null;
    if (rows < 1 || rows > 30 || cols < 1 || cols > 30) return null;
    if (mines < 1 || mines >= rows * cols) return null;
    const minePositions: [number, number][] = [];
    for (let i = 0; i < rows * cols; i++) {
      const byteIdx = 6 + (i >> 3);
      if (byteIdx >= bin.length) break;
      if (bin.charCodeAt(byteIdx) & (1 << (7 - (i & 7)))) {
        minePositions.push([Math.floor(i / cols), i % cols]);
      }
    }
    if (minePositions.length !== mines) return null;
    return { rows, cols, mines, minePositions };
  } catch {
    return null;
  }
}

// ── Sound ──────────────────────────────────────────────────────────────────

let _actx: AudioContext | null = null;

function getACtx(): AudioContext {
  if (!_actx) _actx = new AudioContext();
  return _actx;
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.1): void {
  try {
    const ctx = getACtx();
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch { /* AudioContext may be unavailable */ }
}

const SFX = {
  reveal: () => tone(523, 0.07, 'sine', 0.09),
  flag:   () => tone(784, 0.09, 'sine', 0.09),
  win:  () => {
    tone(523, 0.12);
    setTimeout(() => tone(659, 0.12), 130);
    setTimeout(() => tone(784, 0.25), 260);
  },
  lose: () => {
    tone(300, 0.15, 'sawtooth', 0.11);
    setTimeout(() => tone(200, 0.3, 'sawtooth', 0.11), 170);
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

const fmtTime = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

function loadBest(lv: LevelName): number | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(`ms_best_${lv}`);
  return v !== null ? parseInt(v, 10) : null;
}

function saveBest(lv: LevelName, secs: number): boolean {
  const cur = loadBest(lv);
  if (cur === null || secs < cur) { localStorage.setItem(`ms_best_${lv}`, String(secs)); return true; }
  return false;
}

// Number colours for light / dark backgrounds
const LIGHT_NUMS = ['', '#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#ff8f00', '#0097a7', '#424242', '#616161'];
const DARK_NUMS  = ['', '#64b5f6', '#81c784', '#ef9a9a', '#ce93d8', '#ffb74d', '#4dd0e1', '#e0e0e0', '#9e9e9e'];

// ── Component ──────────────────────────────────────────────────────────────

export default function Minesweeper() {
  const [level,       setLevel]       = useState<LevelName>('easy');
  const [board,       setBoard]       = useState<Cell[][]>(() => createBoard(9, 9, 10));
  const [status,      setStatus]      = useState<GameStatus>('idle');
  const [flags,       setFlags]       = useState(0);
  const [elapsed,     setElapsed]     = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme,       setTheme]       = useState<Theme>('system');
  const [soundOn,     setSoundOn]     = useState(true);
  const [isDark,      setIsDark]      = useState(false);
  const [bestTimes,   setBestTimes]   = useState<Partial<Record<LevelName, number>>>({});
  const [isNewBest,   setIsNewBest]   = useState(false);
  const [streaks,     setStreaks]     = useState<Partial<Record<LevelName, number>>>({});
  const [revealMines, setRevealMines] = useState(false);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [replayConfig,   setReplayConfig]   = useState<{ rows: number; cols: number; mines: number } | null>(null);
  const [gameLinkStatus, setGameLinkStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [visitCount,     setVisitCount]     = useState(0);
  const [isOwner,        setIsOwner]        = useState(false);
  const [cellSize,    setCellSize]    = useState(() => {
    if (typeof window === 'undefined') return 32;
    const { cols } = LEVELS.easy;
    const avail = window.innerWidth - 16 - 14 - (cols - 1) * 2;
    return Math.min(32, Math.max(8, Math.floor(avail / cols)));
  });

  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const longPressed   = useRef(false);
  const elapsedRef    = useRef(0);

  const { rows, cols, mines } = replayConfig ?? LEVELS[level];

  // ── Board id (only meaningful once the game is over) ────────────────────

  const boardId = useMemo<string | null>(() => {
    if (status !== 'won' && status !== 'lost') return null;
    const positions: [number, number][] = [];
    for (let r = 0; r < board.length; r++)
      for (let c = 0; c < board[r].length; c++)
        if (board[r][c].mine) positions.push([r, c]);
    return encodeBoard(rows, cols, mines, positions);
  }, [board, status, rows, cols, mines]);

  // ── Init from localStorage ─────────────────────────────────────────────

  useEffect(() => {
    const t = localStorage.getItem('ms_theme') as Theme | null;
    if (t) setTheme(t);
    const snd = localStorage.getItem('ms_sound');
    if (snd !== null) setSoundOn(snd === 'on');
    const bt: Partial<Record<LevelName, number>> = {};
    for (const lv of Object.keys(LEVELS) as LevelName[]) {
      const v = loadBest(lv);
      if (v !== null) bt[lv] = v;
    }
    setBestTimes(bt);
    const sk: Partial<Record<LevelName, number>> = {};
    for (const lv of Object.keys(LEVELS) as LevelName[]) {
      const v = localStorage.getItem(`ms_streak_${lv}`);
      if (v !== null) sk[lv] = parseInt(v, 10);
    }
    setStreaks(sk);
  }, []);

  // ── Replay from URL hash (#g=<base64>) ─────────────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash.startsWith('#g=')) return;
    const id = hash.slice(3);
    const decoded = decodeBoard(id);
    if (!decoded) return;
    const { rows: dr, cols: dc, mines: dm, minePositions } = decoded;

    const matchedLevel = (Object.keys(LEVELS) as LevelName[]).find(
      lv => lv !== 'replay' && LEVELS[lv].rows === dr && LEVELS[lv].cols === dc && LEVELS[lv].mines === dm
    );
    if (matchedLevel) {
      setLevel(matchedLevel);
    } else {
      setReplayConfig({ rows: dr, cols: dc, mines: dm });
      setLevel('replay');
    }

    setBoard(createBoardFromPositions(dr, dc, minePositions));
    setStatus('playing');
    setFlags(0);
    setElapsed(0);
    elapsedRef.current = 0;

    const ownerKey = `ms_owner_${id}`;
    const visitKey = `ms_visit_${id}`;
    const ownerTs = localStorage.getItem(ownerKey);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    let owner = false;
    if (ownerTs !== null) {
      const ts = parseInt(ownerTs, 10);
      if (!Number.isFinite(ts) || Date.now() - ts > sevenDaysMs) {
        localStorage.removeItem(ownerKey);
      } else {
        owner = true;
      }
    }
    const cur = parseInt(localStorage.getItem(visitKey) ?? '0', 10);
    const next = (Number.isFinite(cur) ? cur : 0) + 1;
    localStorage.setItem(visitKey, String(next));
    setIsOwner(owner);
    setVisitCount(next);
  }, []);

  // ── Visit count: poll localStorage while owner overlay is open ─────────

  useEffect(() => {
    if ((status !== 'won' && status !== 'lost') || !isOwner || !boardId) return;
    const visitKey = `ms_visit_${boardId}`;
    const iv = setInterval(() => {
      setVisitCount(parseInt(localStorage.getItem(visitKey) ?? '0', 10));
    }, 1000);
    return () => clearInterval(iv);
  }, [status, isOwner, boardId]);

  // ── Theme ──────────────────────────────────────────────────────────────

  useEffect(() => {
    localStorage.setItem('ms_theme', theme);

    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      setIsDark(false);
      return;
    }
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      setIsDark(true);
      return;
    }
    // system
    document.documentElement.removeAttribute('data-theme');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // ── Sound persist ──────────────────────────────────────────────────────

  useEffect(() => {
    localStorage.setItem('ms_sound', soundOn ? 'on' : 'off');
  }, [soundOn]);

  // ── Timer ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (status === 'playing') {
      timerRef.current = setInterval(() => {
        setElapsed(e => {
          const next = e + 1;
          elapsedRef.current = next;
          return next;
        });
      }, 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (status === 'idle') { setElapsed(0); elapsedRef.current = 0; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  // ── Responsive cell size ───────────────────────────────────────────────

  useEffect(() => {
    const compute = () => {
      const vw = window.innerWidth;
      // 8px body-padding each side + board: 3px border×2 + 4px padding×2
      const avail = vw - 16 - 14 - (cols - 1) * 2;
      setCellSize(Math.min(32, Math.max(8, Math.floor(avail / cols))));
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [cols]);

  // ── Record win ─────────────────────────────────────────────────────────

  const recordWin = useCallback((lv: LevelName) => {
    const t = elapsedRef.current;
    const isNew = saveBest(lv, t);
    setIsNewBest(isNew);
    if (isNew) setBestTimes(prev => ({ ...prev, [lv]: t }));
    setStreaks(prev => {
      const next = (prev[lv] ?? 0) + 1;
      localStorage.setItem(`ms_streak_${lv}`, String(next));
      return { ...prev, [lv]: next };
    });
  }, []);

  // ── Game logic ─────────────────────────────────────────────────────────

  const doFlag = useCallback((r: number, c: number) => {
    setBoard(prev => {
      if (prev[r][c].revealed) return prev;
      const b = prev.map(row => row.map(cl => ({ ...cl })));
      const cell = b[r][c];
      cell.flagged = !cell.flagged;
      setFlags(f => f + (cell.flagged ? 1 : -1));
      if (soundOn) SFX.flag();
      return b;
    });
  }, [soundOn]);

  const handleCell = useCallback((r: number, c: number) => {
    if (status === 'won' || status === 'lost') return;
    setBoard(prev => {
      const cell0 = prev[r][c];
      if (cell0.flagged || cell0.revealed) return prev;
      const b = prev.map(row => row.map(cl => ({ ...cl })));
      if (b[r][c].mine) {
        b.forEach(row => row.forEach(cl => { if (cl.mine) cl.revealed = true; }));
        setStatus('lost');
        setStreaks(prev => { localStorage.setItem(`ms_streak_${level}`, '0'); return { ...prev, [level]: 0 }; });
        if (soundOn) SFX.lose();
        return b;
      }
      revealCascade(b, r, c);
      if (status === 'idle') setStatus('playing');
      if (checkWin(b)) {
        setStatus('won');
        if (soundOn) SFX.win();
        recordWin(level);
      } else {
        if (soundOn) SFX.reveal();
      }
      return b;
    });
  }, [status, level, soundOn, recordWin]);

  const handleChord = useCallback((r: number, c: number) => {
    if (status === 'won' || status === 'lost') return;
    const cell0 = board[r][c];
    if (!cell0.revealed || cell0.mine || cell0.count === 0) return;
    let fc = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].flagged) fc++;
      }
    if (fc !== cell0.count) return;
    const b = board.map(row => row.map(cl => ({ ...cl })));
    let hitMine = false;
    outer: for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          const nb = b[nr][nc];
          if (!nb.revealed && !nb.flagged && nb.mine) { hitMine = true; break outer; }
        }
      }
    if (hitMine) {
      b.forEach(row => row.forEach(cl => { if (cl.mine) cl.revealed = true; }));
      setBoard(b);
      setStatus('lost');
      setStreaks(prev => { localStorage.setItem(`ms_streak_${level}`, '0'); return { ...prev, [level]: 0 }; });
      if (soundOn) SFX.lose();
      return;
    }
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) revealCascade(b, nr, nc);
      }
    setBoard(b);
    if (checkWin(b)) {
      setStatus('won');
      if (soundOn) SFX.win();
      recordWin(level);
    } else {
      if (soundOn) SFX.reveal();
    }
  }, [board, status, rows, cols, level, soundOn, recordWin]);

  const reset = useCallback((lv: LevelName = level) => {
    if (touchTimerRef.current) { clearTimeout(touchTimerRef.current); touchTimerRef.current = null; }
    longPressed.current = false;
    const { rows: r, cols: c, mines: m } = LEVELS[lv];
    setBoard(createBoard(r, c, m));
    setStatus('idle');
    setFlags(0);
    setLevel(lv);
    setIsNewBest(false);
    setRevealMines(false);
    setReplayConfig(null);
    setIsOwner(false);
    setVisitCount(0);
    setGameLinkStatus('idle');
  }, [level]);

  // ── Touch: long-press to flag ──────────────────────────────────────────

  const handleTouchStart = useCallback((r: number, c: number) => {
    if (status === 'won' || status === 'lost') return;
    longPressed.current = false;
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    touchTimerRef.current = setTimeout(() => {
      longPressed.current = true;
      touchTimerRef.current = null;
      doFlag(r, c);
    }, 450);
  }, [status, doFlag]);

  const cancelLongPress = useCallback(() => {
    if (touchTimerRef.current) { clearTimeout(touchTimerRef.current); touchTimerRef.current = null; }
  }, []);

  const handleShare = useCallback(async () => {
    const cur = streaks[level] ?? 0;
    const emoji = status === 'won' ? '✅' : '❌';
    const txt = `💣 ${fmtTime(elapsed)} ${emoji} ${level} streak ${cur}`;
    try {
      await navigator.clipboard.writeText(txt);
      setShareStatus('copied');
      setTimeout(() => setShareStatus('idle'), 1500);
    } catch {
      setShareStatus('failed');
      setTimeout(() => setShareStatus('idle'), 1500);
    }
  }, [status, elapsed, level, streaks]);

  // ── Share game: copy a URL that reproduces this exact board ────────────

  const handleShareGame = useCallback(async () => {
    if (!boardId) return;
    const url = `${window.location.origin}${window.location.pathname}#g=${boardId}`;
    try {
      await navigator.clipboard.writeText(url);
      setGameLinkStatus('copied');
      const ownerKey = `ms_owner_${boardId}`;
      const visitKey = `ms_visit_${boardId}`;
      if (localStorage.getItem(ownerKey) === null) {
        localStorage.setItem(ownerKey, String(Date.now()));
      }
      if (localStorage.getItem(visitKey) === null) {
        localStorage.setItem(visitKey, '0');
      }
      setIsOwner(true);
      setVisitCount(parseInt(localStorage.getItem(visitKey) ?? '0', 10));
      setTimeout(() => setGameLinkStatus('idle'), 1500);
    } catch {
      setGameLinkStatus('failed');
      setTimeout(() => setGameLinkStatus('idle'), 1500);
    }
  }, [boardId]);

  // onClick: skip if the touch was a long-press (flag was already toggled)
  const handleCellClick = useCallback((r: number, c: number) => {
    if (longPressed.current) { longPressed.current = false; return; }
    handleCell(r, c);
  }, [handleCell]);

  const handleContextMenu = useCallback((e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    if (status === 'won' || status === 'lost') return;
    doFlag(r, c);
  }, [status, doFlag]);

  // ── Render ─────────────────────────────────────────────────────────────

  const numColors = isDark ? DARK_NUMS : LIGHT_NUMS;
  const best = bestTimes[level];
  const fontSize = Math.max(7, Math.floor(cellSize * 0.56));
  const safeCells = rows * cols - mines;
  const cellsRevealed = useMemo(() => {
    if (status !== 'won' && status !== 'lost') return 0;
    let n = 0;
    for (const row of board) for (const c of row) if (c.revealed && !c.mine) n++;
    return n;
  }, [board, status]);
  const accuracy = safeCells > 0 ? Math.round((cellsRevealed / safeCells) * 100) : 100;
  const streak = streaks[level] ?? 0;

  return (
    <div className="ms-wrap">

      {/* ── Top bar ── */}
      <div className="ms-bar">
        <div className="ms-stats">
          <span className="ms-stat" title="Flags placed / Total mines">🚩 {flags}/{mines}</span>
          <span className="ms-stat" title="Elapsed time">⏱ {fmtTime(elapsed)}</span>
          {best !== undefined && (
            <span className="ms-stat ms-stat-best" title={`Best time on ${level}`}>🏆 {fmtTime(best)}</span>
          )}
        </div>
        <div className="ms-bar-actions">
          <button
            className="ms-btn ms-icon-btn"
            onClick={() => reset()}
            title="New game"
            aria-label="New game"
          >↻</button>
          <button
            className="ms-btn ms-icon-btn"
            onClick={() => setSettingsOpen(o => !o)}
            title="Settings"
            aria-label="Settings"
            aria-expanded={settingsOpen}
          >⚙</button>
          <button
            className="ms-btn ms-icon-btn ms-premium-btn"
            onClick={() => {}}
            title="Premium"
            aria-label="Premium"
          >💎</button>
        </div>
      </div>

      {/* ── Settings panel ── */}
      {settingsOpen && (
        <div className="ms-settings" role="region" aria-label="Settings">
          <div className="ms-settings-row">
            <span className="ms-settings-lbl">Difficulty</span>
            <div className="ms-btn-grp">
              {(Object.keys(LEVELS) as LevelName[]).map(lv => (
                <button
                  key={lv}
                  className={`ms-btn${lv === level ? ' ms-btn-sel' : ''}`}
                  onClick={() => { reset(lv); setSettingsOpen(false); }}
                >
                  {lv[0].toUpperCase() + lv.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="ms-settings-row">
            <span className="ms-settings-lbl">Theme</span>
            <div className="ms-btn-grp">
              {(['system', 'light', 'dark'] as Theme[]).map(t => (
                <button
                  key={t}
                  className={`ms-btn${t === theme ? ' ms-btn-sel' : ''}`}
                  onClick={() => setTheme(t)}
                >
                  {t === 'system' ? '💻 System' : t === 'light' ? '☀ Light' : '🌙 Dark'}
                </button>
              ))}
            </div>
          </div>
          <div className="ms-settings-row">
            <span className="ms-settings-lbl">Sound</span>
            <button
              className={`ms-btn${soundOn ? ' ms-btn-sel' : ''}`}
              onClick={() => setSoundOn(s => !s)}
            >
              {soundOn ? '🔊 On' : '🔇 Off'}
            </button>
          </div>
        </div>
      )}

      {/* ── Board ── */}
      <div className="ms-board-wrap">
        <div
          className="ms-board"
          style={{ gridTemplateColumns: `repeat(${cols}, ${cellSize}px)` }}
          onTouchMove={cancelLongPress}
        >
          {board.map((row, r) =>
            row.map((cell, c) => (
              <button
                key={`${r}-${c}`}
                className={`ms-cell ${cell.revealed ? (cell.mine ? `ms-mine${revealMines ? ' ms-mine-emphasis' : ''}` : 'ms-open') : 'ms-hidden'}`}
                style={{
                  width: cellSize,
                  height: cellSize,
                  fontSize,
                  color: cell.mine && cell.revealed ? '#fff' : numColors[cell.count],
                }}
                onClick={() => handleCellClick(r, c)}
                onDoubleClick={() => handleChord(r, c)}
                onContextMenu={e => handleContextMenu(e, r, c)}
                onTouchStart={() => handleTouchStart(r, c)}
                onTouchEnd={cancelLongPress}
                aria-label={
                  cell.revealed
                    ? `${r},${c} ${cell.mine ? 'mine' : cell.count || 'empty'}`
                    : cell.flagged
                    ? `${r},${c} flagged`
                    : `${r},${c} hidden`
                }
              >
                {cell.revealed
                  ? cell.mine ? '💣' : (cell.count || '')
                  : cell.flagged ? '🚩' : ''}
              </button>
            ))
          )}
        </div>

        {/* ── Game-over overlay ── */}
        {(status === 'won' || status === 'lost') && (
          <div
            className="ms-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={status === 'won' ? 'You won' : 'Game over'}
          >
            <div className="ms-overlay-card">
              <p className="ms-overlay-title">
                {status === 'won' ? '🎉 You Won!' : '💥 Game Over'}
              </p>
              <span className="ms-difficulty-badge">{level}</span>
              <div className="ms-stats-grid">
                <div className="ms-stat-tile">
                  <span className="ms-stat-tile-label">Time</span>
                  <span className="ms-stat-tile-value">{fmtTime(elapsed)}</span>
                </div>
                <div className="ms-stat-tile">
                  <span className="ms-stat-tile-label">Mines</span>
                  <span className="ms-stat-tile-value">💣 {mines}</span>
                </div>
                <div className="ms-stat-tile">
                  <span className="ms-stat-tile-label">Revealed</span>
                  <span className="ms-stat-tile-value">{cellsRevealed}</span>
                </div>
                <div className="ms-stat-tile">
                  <span className="ms-stat-tile-label">Accuracy</span>
                  <span className="ms-stat-tile-value">{accuracy}%</span>
                </div>
                <div className="ms-stat-tile">
                  <span className="ms-stat-tile-label">Streak</span>
                  <span className="ms-stat-tile-value">{streak}</span>
                </div>
                <div className="ms-stat-tile">
                  <span className="ms-stat-tile-label">Best</span>
                  <span className="ms-stat-tile-value">
                    {isNewBest ? '🏆 New!' : best !== undefined ? `🏆 ${fmtTime(best)}` : '—'}
                  </span>
                </div>
              </div>
              {status === 'lost' && (
                <button
                  className={`ms-reveal-mines${revealMines ? ' ms-reveal-mines-active' : ''}`}
                  onClick={() => setRevealMines(r => !r)}
                >
                  {revealMines ? '🔍 Hiding mines' : '🔍 Where are the mines?'}
                </button>
              )}
              <div className="ms-actions">
                <button className="ms-btn" onClick={() => reset()}>Play Again</button>
                <button className="ms-btn" onClick={() => setSettingsOpen(true)}>Change Difficulty</button>
                <button className="ms-btn" onClick={handleShareGame}>
                  {gameLinkStatus === 'copied' ? '✓ Copied!' : gameLinkStatus === 'failed' ? '✗ Copy failed' : '🔗 Share game'}
                </button>
                <button className="ms-btn" onClick={handleShare}>
                  {shareStatus === 'copied' ? '✓ Copied' : shareStatus === 'failed' ? '✗ Failed' : '📋 Share Result'}
                </button>
              </div>
              {isOwner && boardId && (
                <p className="ms-share-counter">Loaded {visitCount} times</p>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
