(function () {
  var clock = document.getElementById('taskbar-clock');
  if (clock) {
    var fmt = function () {
      var d = new Date();
      var h = d.getHours();
      var m = d.getMinutes();
      var ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12; if (h === 0) h = 12;
      return (h < 10 ? ' ' + h : h) + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
    };
    var tick = function () { clock.textContent = fmt(); };
    tick();
    setInterval(tick, 15000);
  }

  var btn = document.getElementById('start-button');
  var menu = document.getElementById('start-menu');
  if (btn && menu) {
    var open = function (state) {
      if (state) { menu.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
      else       { menu.setAttribute('hidden', '');  btn.setAttribute('aria-expanded', 'false'); }
    };
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      open(menu.hasAttribute('hidden'));
    });
    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && e.target !== btn) open(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') open(false);
    });
  }
})();
