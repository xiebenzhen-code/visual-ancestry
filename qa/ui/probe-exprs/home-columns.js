(() => {
  const wall = document.querySelector('.edition-plates');
  const count = () => [...document.querySelectorAll('.edition-plates .plate')].filter((p) => { const r = p.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).length;
  const out = { viewport: innerWidth + 'x' + innerHeight, natural: getComputedStyle(wall).columnCount, byColumns: {} };
  for (const n of [4, 5, 6, 7]) {
    wall.style.columnCount = String(n);
    out.byColumns[n] = count();
  }
  wall.style.columnCount = '';
  return out;
})()
