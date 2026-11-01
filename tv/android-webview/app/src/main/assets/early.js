(function () {
  window.addEventListener('error', function (e) {
    console.error('window.onerror ' + e.message + ' ' + (e.error && e.error.stack || ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    console.error('rejection ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason));
  });
  console.log('early-ready ' + navigator.userAgent);
})();
