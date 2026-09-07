'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

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

  const { rows, cols, mines } = LEVELS[level];

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
  }, []);

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
                className={`ms-cell ${cell.revealed ? (cell.mine ? 'ms-mine' : 'ms-open') : 'ms-hidden'}`}
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
        {(status === 'won' || status === 'lost') && (() => {
          // Derived stats — bugfix-only, no new state.
          let revealedCount = 0;
          let totalSafe = 0;
          for (const row of board) for (const c of row) {
            if (!c.mine) totalSafe++;
            if (c.revealed && !c.mine) revealedCount++;
          }
          const accuracyPct =
            totalSafe === 0
              ? 0
              : status === 'won'
                ? 100
                : Math.round((revealedCount / totalSafe) * 100);
          const diffLabel =
            level === 'easy' ? 'EASY' :
            level === 'medium' ? 'MED' :
            'HARD';
          return (
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
                <div className="ms-overlay-pill" aria-label={`Difficulty: ${level}`}>
                  {diffLabel}
                  {status === 'won' && isNewBest && (
                    <span className="ms-new-best">🏆 New best!</span>
                  )}
                </div>
                <div className="ms-stats-grid">
                  <div className="ms-stat-tile">
                    <span className="ms-stat-tile-label">Mines</span>
                    <span className="ms-stat-tile-value">{mines}</span>
                  </div>
                  <div className="ms-stat-tile">
                    <span className="ms-stat-tile-label">Time</span>
                    <span className="ms-stat-tile-value">{fmtTime(elapsed)}</span>
                  </div>
                  <div className="ms-stat-tile">
                    <span className="ms-stat-tile-label">Revealed</span>
                    <span className="ms-stat-tile-value">{revealedCount}/{totalSafe}</span>
                  </div>
                  <div className="ms-stat-tile">
                    <span className="ms-stat-tile-label">Accuracy</span>
                    <span className="ms-stat-tile-value">{accuracyPct}%</span>
                  </div>
                </div>
                {/* Ad placeholder — future monetization surface */}
                <div className="ms-ad-slot" aria-hidden="true" />
                <button className="ms-btn ms-play-again" onClick={() => reset()}>
                  Play Again
                </button>
              </div>
            </div>
          );
        })()}
      </div>

    </div>
  );
}
