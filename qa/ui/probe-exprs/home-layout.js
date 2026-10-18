(() => {
  const plates = [...document.querySelectorAll('.edition-plates .plate')];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; };
  const mast = document.querySelector('.edition-masthead');
  const form = document.querySelector('#home-find');
  const wall = document.querySelector('.edition-plates');
  return {
    viewport: innerWidth + 'x' + innerHeight,
    masthead: rect(mast),
    searchForm: rect(form),
    wall: rect(wall),
    columns: getComputedStyle(wall).columnCount,
    plates: plates.length,
    inView: plates.filter((p) => { const r = p.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).length,
    rows: plates.slice(0, 6).map((p) => ({ href: p.getAttribute('href'), ...rect(p) })),
  };
})()
