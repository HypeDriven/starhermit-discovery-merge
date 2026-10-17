// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice board and keeps playing through the board's keyboard-operable cell buttons — deliver a matching
// piece, else merge the highest identical pair, else tap the generator — so pieces pop, fly and merge
// with sparks, restoration props appear and the post chain runs; a finished board is replayed.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-graphics #gfx-preset');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForSelector('#overlay-root .overlay', { state: 'detached' });
}

async function startBoard(page) {
  await page.click('#btn-play');
  await page.click('[data-mode="practice"]');
  await page.locator('#setup-body .card-btn').first().click();
  await page.waitForSelector('#screen-play:not([hidden])');
}

// One action, chosen from the board's accessible labels; returns the cells to click in order.
function plan() {
  const cells = [...document.querySelectorAll('#dom-board .dm-cell')].map((b) => {
    const label = b.getAttribute('aria-label') || '';
    const i = +b.dataset.cell;
    if (label.startsWith('Empty cell')) return { i, kind: 'empty' };
    if (label.startsWith('Field Kit generator')) return { i, kind: 'generator' };
    const m = label.match(/^(.+), tier (\d+)(, cobwebbed)?/);
    return m ? { i, kind: 'piece', name: m[1], tier: +m[2], webbed: !!m[3] } : { i, kind: 'other' };
  });
  for (const [ci, card] of [...document.querySelectorAll('.request-card')].entries()) {
    if (card.classList.contains('done')) continue;
    for (const n of card.querySelectorAll('.need:not(.met)')) {
      const piece = cells.find((c) => c.kind === 'piece' && !c.webbed && c.name === n.children[1]?.textContent);
      if (piece) return { cells: [piece.i], deliver: ci };
    }
  }
  const groups = new Map();
  for (const p of cells.filter((c) => c.kind === 'piece' && c.tier < 6)) (groups.get(p.name) || groups.set(p.name, []).get(p.name)).push(p);
  const pair = [...groups.values()].filter((g) => g.length >= 2 && g.some((p) => !p.webbed)).sort((a, b) => b[0].tier - a[0].tier)[0];
  if (pair) { const from = pair.find((p) => !p.webbed); return { cells: [from.i, pair.find((p) => p.i !== from.i).i] }; }
  const gen = cells.find((c) => c.kind === 'generator');
  if (gen && cells.some((c) => c.kind === 'empty')) return { cells: [gen.i] };
  return { stuck: true };
}

async function act(page) {
  if (await page.locator('#screen-results:not([hidden])').count()) {
    await page.click('#btn-results-home');
    await page.waitForSelector('#screen-title:not([hidden])');
    await startBoard(page);
    return;
  }
  // With the 3D board on, the semantic board is the keyboard path to every cell (focus + Enter).
  const press = async (loc) => { await loc.focus(); await page.keyboard.press('Enter'); };
  const sel = page.locator('#dom-board .dm-cell.selected');
  if (await sel.count()) await press(sel.first());
  const p = await page.evaluate(plan);
  if (p.stuck) { await page.click('#btn-results-home').catch(() => {}); return; }
  for (const i of p.cells) { await press(page.locator(`#dom-board .dm-cell[data-cell="${i}"]`)); await page.waitForTimeout(150); }
  if (p.deliver != null) {
    const btn = page.locator('.request-card').nth(p.deliver).locator('button');
    if (await btn.isVisible() && await btn.isEnabled()) await btn.click();
  }
}

export async function start(page) {
  await startBoard(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await act(page); } catch { if (!open) return; }
      await new Promise((r) => setTimeout(r, 350));
    }
  })();
  await page.waitForTimeout(800);
}
