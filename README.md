# AI Code Reviewer

## Локальный запуск без Docker

Установите зависимости через `npm ci` в каталогах `backend`, `apps/remote` и
`apps/host`. В отдельных терминалах запустите `npm start` в каждом из этих
каталогов. Для генерации ревью backend также требуется настроенная Ollama.

Откройте http://localhost:3000. Remote можно открыть отдельно на
http://localhost:3001.

Frontend использует относительный адрес `/api/review`. Оба webpack dev server
проксируют `/api/*` на `http://localhost:5000/*`. Host также проксирует
`/remote/*` на `http://localhost:3001/*`, включая `remoteEntry.js` и чанки.

## Запуск через Docker Compose

```sh
docker compose up --build
```

Откройте http://localhost:3000 (host) или http://localhost:3001 (remote).
Для генерации ревью модель из `OLLAMA_MODEL` должна быть доступна в Ollama.

В контейнерах маршрутизацию выполняет Nginx:

| Публичный путь | Внутренний адрес |
| --- | --- |
| `/api/review` на host или remote | `http://backend:5000/review` |
| `/remote/remoteEntry.js` на host | `http://remote:80/remoteEntry.js` |
| `/remote/<chunk>.js` на host | `http://remote:80/<chunk>.js` |

## Production

Опубликуйте host через свой домен с HTTPS. Приложение предполагает размещение
в корне домена; `/api/` и `/remote/` должны направляться в Nginx host.
Backend и remote должны быть доступны ему по именам из Docker Compose.
Адрес домена не встраивается в frontend: API и Module Federation используют
пути от корня сайта, а `output.publicPath: 'auto'` определяет адреса чанков по
адресу загруженного скрипта. Смена домена не требует пересборки frontend.

Адреса `localhost` в `devServer.proxy` относятся только к локальной разработке.
