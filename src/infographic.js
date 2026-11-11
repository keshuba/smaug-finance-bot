const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const COLORS = ['#d5ae58', '#8db6a6', '#c77d65', '#899ec2', '#ad8eb9', '#6e9992'];

export function infographicHtml({ eyebrow, title, subtitle, total, sections = [], footer, pie = [] }) {
  const positive = pie.filter(item => Number(item.value) > 0);
  const whole = positive.reduce((sum, item) => sum + Number(item.value), 0);
  let cursor = 0;
  const wedges = positive.slice(0, 5).map((item, index) => {
    const start = cursor;
    cursor += Number(item.value) / whole * 100;
    return `${COLORS[index]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  if (cursor < 100 && wedges.length) wedges.push(`${COLORS[5]} ${cursor.toFixed(2)}% 100%`);
  const chart = wedges.length ? `<div class="chart">
    <div class="pie" style="background:conic-gradient(${wedges.join(',')})"></div>
    <div class="legend">${positive.slice(0, 5).map((item, index) =>
      `<div><i style="background:${COLORS[index]}"></i>${escape(item.label)}</div>`).join('')}
      ${positive.length > 5 ? `<div><i style="background:${COLORS[5]}"></i>Остальное</div>` : ''}
    </div></div>` : '';
  const blocks = sections.map(section => `<section><h2>${escape(section.heading)}</h2>
    ${section.rows.length ? section.rows.map(row => `<div class="row${row.muted ? ' muted' : ''}">
      <span>${escape(row.label)}</span><strong>${escape(row.value)}</strong></div>`).join('')
      : '<div class="empty">Пока нет записей</div>'}</section>`).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8">
  <style>
    *{box-sizing:border-box}body{margin:0;background:#ece9e1;color:#f9f3e4;font:16px Arial,sans-serif}
    main{width:620px;height:790px;padding:30px;background:linear-gradient(135deg,#111918,#2a352f)}
    article{height:730px;position:relative;border:1px solid #6b765f;border-radius:26px;padding:27px;background:rgba(7,12,11,.35);overflow:hidden}
    .eyebrow,h2{color:#e4c47d;font-weight:700;letter-spacing:.11em;text-transform:uppercase}
    .eyebrow{font-size:13px}h1{font-size:31px;color:#edcf8d;margin:13px 0 8px}
    .subtitle{color:#bac8bc;line-height:1.35}.total{font-size:36px;font-weight:700;margin:24px 0 16px}
    section{border-top:1px solid #526154;padding-top:12px;margin:17px 0}
    h2{font-size:13px;margin:0 0 10px}.row{display:flex;gap:14px;justify-content:space-between;margin:8px 0}
    .row span{max-width:66%;line-height:1.2}.row strong{white-space:nowrap;text-align:right}
    .muted,.empty{color:#adbaaf}.chart{display:flex;align-items:center;gap:23px;margin:8px 0 15px}
    .pie{width:114px;height:114px;flex:none;border-radius:50%;box-shadow:0 0 0 8px rgba(255,255,255,.04)}
    .legend{font-size:13px;color:#dce5da}.legend div{margin:5px 0}.legend i{display:inline-block;width:9px;height:9px;margin-right:7px;border-radius:50%}
    footer{position:absolute;left:27px;right:27px;bottom:22px;color:#b7c3b7;font-size:12px;line-height:1.3;background:#19221d}
  </style><main><article><div class="eyebrow">${escape(eyebrow)}</div>
  <h1>${escape(title)}</h1><div class="subtitle">${escape(subtitle)}</div>
  ${total ? `<div class="total">${escape(total)}</div>` : ''}${chart}${blocks}
  <footer>${escape(footer)}</footer></article></main></html>`;
}
