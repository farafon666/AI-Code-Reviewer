# AI Code Reviewer

## Локальный запуск без Docker

Установите Ollama и запустите сервер в отдельном терминале, если он ещё не работает:

```sh
ollama serve
```

В другом терминале загрузите модель до запуска backend:

```sh
ollama pull qwen2.5-coder:7b
```

Установите зависимости через `npm ci` в каталогах `backend`, `apps/remote` и
`apps/host`. В отдельных терминалах запустите `npm start` в каждом из этих
каталогов. По умолчанию backend обращается к `http://localhost:11434` и использует
`qwen2.5-coder:7b`. Для другой модели задайте `OLLAMA_MODEL` в `backend/.env` и
заранее загрузите её через `ollama pull <имя-модели>`. Адрес сервера можно изменить
через `OLLAMA_BASE_URL` в том же файле.

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

Compose ждёт успешного healthcheck Ollama, затем запускает одноразовый сервис
`ollama-init`. Он проверяет наличие модели и автоматически загружает её, если она
отсутствует. Backend запускается только после успешного завершения подготовки.
По умолчанию используется `qwen2.5-coder:7b`. Первый запуск требует доступа к
реестру моделей и может занять время; прогрев модели в память не выполняется.

Для выбора другой модели создайте `.env` в корне проекта рядом с
`docker-compose.yml`:

```dotenv
OLLAMA_MODEL=qwen2.5-coder:1.5b
```

Compose передаёт это значение и загрузчику, и backend. Корневой `.env` используется
для Docker Compose; при запуске без Docker настройки backend берутся из
`backend/.env`.

Модели сохраняются в volume `ollama_data`. При повторном запуске уже доступная
модель используется без повторного скачивания. `docker compose down` сохраняет
volume, а `docker compose down -v` удаляет его вместе с моделями.

Посмотреть состояние сервисов и ход подготовки:

```sh
docker compose ps -a
docker compose logs -f ollama ollama-init
```

Если Ollama недоступна, проверка готовности блокирует запуск зависимых сервисов.
Если загрузка модели завершается ошибкой, `ollama-init` выходит с ненулевым кодом,
а backend не запускается. После устранения причины (например, ошибки имени модели
или доступа к реестру) повторите `docker compose up --build`.

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
