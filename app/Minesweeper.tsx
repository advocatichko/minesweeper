'use client';

import { useState, useCallback, useEffect } from 'react';

type Cell = {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  count: number;
};

const LEVELS = {
  easy: { rows: 9, cols: 9, mines: 10 },
  medium: { rows: 16, cols: 16, mines: 40 },
  hard: { rows: 16, cols: 30, mines: 99 },
} as const;

type LevelName = keyof typeof LEVELS;

function createBoard(rows: number, cols: number, mines: number): Cell[][] {
  const board: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ mine: false, revealed: false, flagged: false, count: 0 })),
  );
  // place mines randomly
  let placed = 0;
  while (placed < mines) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    if (!board[r][c].mine) {
      board[r][c].mine = true;
      placed++;
    }
  }
  // compute counts
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].mine) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr,
            nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].mine) n++;
        }
      board[r][c].count = n;
    }
  }
  return board;
}

function revealCascade(board: Cell[][], r: number, c: number) {
  const rows = board.length,
    cols = board[0].length;
  const stack: [number, number][] = [[r, c]];
  while (stack.length) {
    const [cr, cc] = stack.pop()!;
    const cell = board[cr][cc];
    if (cell.revealed || cell.flagged) continue;
    cell.revealed = true;
    if (cell.count === 0 && !cell.mine) {
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = cr + dr,
            nc = cc + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !board[nr][nc].revealed)
            stack.push([nr, nc]);
        }
    }
  }
}

const NUM_COLORS = ['', '#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#ff8f00', '#0097a7', '#000', '#616161'];

export default function Minesweeper() {
  const [level, setLevel] = useState<LevelName>('easy');
  const [board, setBoard] = useState<Cell[][]>(() => {
    const { rows, cols, mines } = LEVELS.easy;
    return createBoard(rows, cols, mines);
  });
  const [status, setStatus] = useState<'idle' | 'playing' | 'won' | 'lost'>('idle');
  const [flags, setFlags] = useState(0);

  const { rows, cols, mines } = LEVELS[level];

  const reset = useCallback((lv: LevelName = level) => {
    const cfg = LEVELS[lv];
    setBoard(createBoard(cfg.rows, cfg.cols, cfg.mines));
    setStatus('idle');
    setFlags(0);
    setLevel(lv);
  }, [level]);

  const checkWin = (b: Cell[][]) => {
    let hidden = 0;
    for (const row of b) for (const c of row) if (!c.revealed && !c.mine) hidden++;
    if (hidden === 0) setStatus('won');
  };

  const handleCell = (r: number, c: number) => {
    if (status === 'won' || status === 'lost') return;
    const b = board.map((row) => row.map((cell) => ({ ...cell })));
    const cell = b[r][c];
    if (cell.flagged || cell.revealed) return;
    if (cell.mine) {
      b.forEach((row) => row.forEach((cl) => { if (cl.mine) cl.revealed = true; }));
      setBoard(b);
      setStatus('lost');
      return;
    }
    revealCascade(b, r, c);
    setBoard(b);
    if (status === 'idle') setStatus('playing');
    checkWin(b);
  };

  const handleFlag = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    if (status === 'won' || status === 'lost') return;
    const b = board.map((row) => row.map((cell) => ({ ...cell })));
    const cell = b[r][c];
    if (cell.revealed) return;
    cell.flagged = !cell.flagged;
    setBoard(b);
    setFlags((f) => f + (cell.flagged ? 1 : -1));
  };

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 24, gap: 12 }}>
      <h1 style={{ margin: 0 }}>💣 Minesweeper</h1>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {(Object.keys(LEVELS) as LevelName[]).map((lv) => (
          <button key={lv} onClick={() => reset(lv)} style={{ padding: '6px 12px', cursor: 'pointer', fontWeight: lv === level ? 700 : 400 }}>
            {lv}
          </button>
        ))}
        <button onClick={() => reset()} style={{ padding: '6px 12px', cursor: 'pointer' }}>↻ reset</button>
      </div>
      <div aria-live="polite" style={{ height: 24, fontSize: 16, fontWeight: 600 }}>
        {status === 'lost' && '💥 Game over'}
        {status === 'won' && '🎉 You won!'}
        <span> 🚩 {flags} / {mines}</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 32px)`,
          gap: 2,
          background: '#bdbdbd',
          padding: 4,
          border: '3px solid #757575',
          touchAction: 'manipulation',
        }}
      >
        {board.map((row, r) =>
          row.map((cell, c) => (
            <button
              key={`${r}-${c}`}
              onClick={() => handleCell(r, c)}
              onContextMenu={(e) => handleFlag(e, r, c)}
              aria-label={cell.revealed ? `cell ${r},${c} ${cell.mine ? 'mine' : cell.count}` : `hidden cell ${r},${c}`}
              style={{
                width: 32,
                height: 32,
                fontSize: 15,
                fontWeight: 700,
                cursor: cell.revealed ? 'default' : 'pointer',
                background: cell.revealed ? (cell.mine ? '#e53935' : '#e0e0e0') : '#9e9e9e',
                border: '1px solid #757575',
                color: cell.mine && cell.revealed ? '#fff' : NUM_COLORS[cell.count],
              }}
            >
              {cell.revealed ? (cell.mine ? '💣' : cell.count || '') : cell.flagged ? '🚩' : ''}
            </button>
          )),
        )}
      </div>
    </main>
  );
}
