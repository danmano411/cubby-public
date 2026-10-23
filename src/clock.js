// The clock in the right-edge bar (dock.html): the computer's own time and time zone (plain Date), in
// its 12/24-hour format. hour12 comes from main (Windows "Long time" format); undefined lets the locale decide.
const $ = (id) => document.getElementById(id);
let hour12;
let fmt;

function formats() {
  fmt = {
    time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12 }),
    weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
    day: new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }),
  };
}

// The locale decides the pieces (hour digits, separator, AM/PM wording); the layout stacks them.
function render() {
  const now = new Date();
  const p = Object.fromEntries(fmt.time.formatToParts(now).map((x) => [x.type, x.value]));
  $('hm').textContent = `${p.hour}:${p.minute}`;
  $('sec').textContent = `:${p.second}`;
  $('ampm').textContent = p.dayPeriod || '';
  $('weekday').textContent = fmt.weekday.format(now);
  $('day').textContent = fmt.day.format(now);
  return now;
}

// Next tick just after the second turns over, so it never lags or skips a second.
function tick() {
  const now = render();
  setTimeout(tick, 1005 - now.getMilliseconds());
}

cubby.on('model', (s) => {
  if (s.clock?.hour12 === hour12) return;
  hour12 = s.clock?.hour12;
  formats();
  render();
});

formats();
tick();
