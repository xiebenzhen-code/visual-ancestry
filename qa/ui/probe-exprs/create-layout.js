(() => {
  const grid = document.querySelector('#create-picks');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; };
  const cards = [...document.querySelectorAll('#create-picks button[data-create-pick]')];
  return {
    viewport: innerWidth + 'x' + innerHeight,
    kicker: rect(document.querySelector('.kicker')),
    title: rect(document.querySelector('.workflow-title')),
    grid: rect(grid),
    columns: getComputedStyle(grid).gridTemplateColumns,
    cards: cards.length,
    inView: cards.filter((c) => { const r = c.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).length,
    cardSample: cards.slice(0, 4).map((c) => ({ id: c.dataset.createPick, ...rect(c) })),
  };
})()
