// Модули из src/utils, которые сервер отдаёт в браузер по /js/shared/<файл> (патч 57).
// Демо на лендинге разбирает короткие записи («кофе 250») тем же кодом, что и бот. Только чистые модули:
// без импортов сервера, базы и секретов; наружу из src/ больше ничего не выходит.
export const SHARED_MODULES = new Set(['quickParse.js', 'categoryHints.js', 'parseAmount.js']);

// Подключает маршрут к приложению Express: GET /js/shared/<файл> (только из списка выше)
export function addSharedModuleRoute(app, utilsDir) {
  app.get('/js/shared/:file', (req, res, next) => {
    if (!SHARED_MODULES.has(req.params.file)) return next();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/javascript').sendFile(`${utilsDir}/${req.params.file}`);
  });
}
