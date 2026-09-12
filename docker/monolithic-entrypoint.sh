#!/bin/sh
mkdir -p /data/db /data/logs /app/logs

# Fork mongod rather than backgrounding it, so it has a pid we can signal and
# can be asked to flush and exit cleanly on the way down.
mongod --dbpath /data/db --fork --logpath /data/logs/mongod.log

# Docker sends SIGTERM to pid 1. Without this trap the shell ignores it, the
# container is SIGKILLed once the stop timeout expires, and mongod has to replay
# its journal on the next start.
shutdown_cleanly() {
    pm2 stop OctoFarm >/dev/null 2>&1
    mongod --dbpath /data/db --shutdown >/dev/null 2>&1
    exit 0
}
trap shutdown_cleanly TERM INT

cd server && pm2 start app.js --name OctoFarm --no-daemon -o '../logs/pm2.log' -e '../logs/pm2.error.log' --time  --restart-delay=1000 --exp-backoff-restart-delay=1500 &

# wait returns as soon as a trapped signal arrives, which is what lets the
# handler above run before the container is killed.
wait $!
