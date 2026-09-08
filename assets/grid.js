// Stage IV. The grid is a working surface only — nothing here is checked
// client-side, and the constraints are rendered as struck-through chips rather
// than a copyable block of prose. That raises the cost of pasting the puzzle
// elsewhere; it does not make it impossible, which is why this stage carries
// a minimum-time floor and paste logging instead.

export function renderGrid(host, payload) {
  const cats = payload.categories;
  const rowKey = Object.keys(cats)[0];          // Shelf
  const cols = Object.keys(cats).slice(1);      // Author, Decade, Borrower
  const rows = cats[rowKey];

  host.innerHTML = `
    <ul class="clues" id="clues">
      ${payload.clues.map((c, i) => `<li data-i="${i}">${c}</li>`).join('')}
    </ul>
    <p class="aside">Tap a constraint once you have used it.</p>
    <table class="grid">
      <thead><tr><th>${rowKey}</th>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((r, ri) => `
          <tr><th scope="row">${r}</th>
            ${cols.map(c => `
              <td><select data-col="${c}" data-row="${ri}" aria-label="${c} on ${rowKey} ${r}">
                <option value="">&mdash;</option>
                ${cats[c].map(v => `<option>${v}</option>`).join('')}
              </select></td>`).join('')}
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="aside" id="clash"></p>`;

  host.querySelectorAll('#clues li').forEach(li =>
    li.addEventListener('click', () => li.classList.toggle('used')));

  // Local feedback only: warn about a value used twice in a column.
  const selects = [...host.querySelectorAll('select')];
  const check = () => {
    const seen = {};
    let clash = false;
    selects.forEach(s => {
      if (!s.value) return;
      const k = s.dataset.col + '|' + s.value;
      if (seen[k]) clash = true;
      seen[k] = true;
    });
    host.querySelector('#clash').textContent =
      clash ? 'One value is placed twice. Each appears exactly once.' : '';
  };
  selects.forEach(s => s.addEventListener('change', check));
}
