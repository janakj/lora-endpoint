import http, { createServer as createHTTPServer } from 'http';
import https from 'https';
import debug from 'debug';
import morgan from 'morgan';
import { dirname } from 'path';
import { AddressInfo } from 'net';
import express from 'express';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { fork } from 'child_process';

import { abort, sleep } from './utils';
import loadArguments from './args';
import craApi from './cra';
import Database from './db';
import Message from './message';

const dbg = debug('lora:main');
const devMode = process.env.NODE_ENV === "development";
(global as any).devMode = devMode;

const log = msg => process.stdout.write(msg);
const err = msg => process.stderr.write(msg);


async function createHTTPSServer(app: http.RequestListener, certFile: string, optKeyFile?: string) {
    const args = {} as any;
    const keyFile = optKeyFile || certFile;

    log(`Loading TLS server certificate from file '${certFile}'...`);
    args.cert = await fs.readFile(certFile);
    log('done.\n');

    log(`Loading TLS private key from file '${keyFile}'...`);
    args.key = await fs.readFile(keyFile);
    log('done.\n');

    log(`Setting up a HTTPS server...`);
    const server = https.createServer(args, app);

    // If we drop privileges later, we will most likely lose access to the TLS
    // certificate and key files. Spawn a helper child process that will keep
    // running under current user (before dropping privileges) and that will
    // re-read the files for us whenever they change.

    const dir = dirname(fileURLToPath(import.meta.url));
    const watcher = fork(`${dir}/watcher.js`, [certFile, keyFile], { cwd: '/' });
    watcher.on('disconnect', abort);
    watcher.on('message', ({ filename, data }: any) => {
        if (data === null) return;
        dbg(`Reloading TLS credentials from '${filename}'`);

        try {
            const contents = Buffer.from(data, 'base64');
            if (filename === certFile) (server as any)._sharedCreds.context.setCert(contents);
            if (filename === keyFile) (server as any)._sharedCreds.context.setKey(contents);
        } catch (error) {
            err(`Failed to reload TLS credentials: ${error.message}\n`);
        }
    });

    log('done.\n');
    return server;
}


async function startListening(server: http.Server | https.Server, sockAddr: any): Promise<AddressInfo | string> {
    if (typeof sockAddr === 'string') {
        try {
            await fs.stat(sockAddr);
            await fs.unlink(sockAddr);
        } catch (e) { /* empty */ }
    }

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        const args: any = {};

        if (typeof sockAddr === 'string') {
            args.path = sockAddr;
        } else {
            args.port = sockAddr.port;
            if (sockAddr.address) args.host = sockAddr.address;
        }

        server.listen(args, async () => {
            const a = server.address();
            if (a === null) {
                reject(new Error('The server has been closed'));
            } else {
                try {
                    if (typeof sockAddr === 'string') await fs.chmod(sockAddr, '666');
                    resolve(a);
                } catch (e) {
                    reject(e);
                }
            }
        });
    });
}


function addrToString(addr: string | AddressInfo) {
    if (typeof addr === 'string') return `unix:${addr}`
    if (addr.family === 'IPv6') return `tcp:[${addr.address}]:${addr.port}`
    return `tcp:${addr.address}:${addr.port}`
}


function dropPrivileges(uid?: number, gid?: number) {
    log(`Changing working directory to /...`);
    process.chdir('/');
    log('done.\n');


    if (gid) {
        log(`Switching to gid ${gid}...`);
        process.setgroups([gid]);
        process.setgid(gid);
        process.setegid(gid);
        log('done.\n');
    }

    if (uid) {
        log(`Switching to ${uid}...`);
        process.setuid(uid);
        process.seteuid(uid);
        log('done.\n');
    }
}


class QueueManager {
    db: Database;
    sink?: Function;
    running: Promise<void>;

    constructor(db: Database) {
        this.db = db;
        this.push = this.push.bind(this);
        this._flush = this._flush.bind(this);
        this.running = Promise.resolve();
    }

    push(msg: Message) {
        if (this.db.isSeen(msg.id)) return;
        this.db.setSeen(msg.id);

        this.db.enqueue(msg);
        this.flush();
    }

    setSink(f: Function) {
        this.sink = f;
        this.flush();
    }

    flush() {
        this.running = this.running.then(this._flush);
    }

    async _flush() {
        if (typeof this.sink === 'undefined') return;

        try {
            await Promise.all(this.db.getMessages().map(async msg => {
                if (this.sink) {
                    await this.sink(msg);
                    this.db.dequeue(msg);
                }
            }));
        } catch (error) {
            await sleep(5);
            this.flush();
        }
    }
}


(async () => {
    log(`Starting in ${devMode ? 'development' : 'production'} mode\n`);
    const args = await loadArguments();
    const db = new Database(args.db);
    const queueMgr = new QueueManager(db);

    let mqttClient;
    if (args.mqtt_broker) {
        log(`Connecting to the MQTT broker at ${args.mqtt_broker}...`);
        const mqtt = (await import('async-mqtt')).default;
        mqttClient = await mqtt.connectAsync(args.mqtt_broker);

        queueMgr.setSink((msg: Message) => mqttClient.publish(`LoRa/${msg.eui}/message`, JSON.stringify(msg)));
        log('done.\n');
    }

    const app = express();
    app.use(morgan(devMode ? 'dev' : 'combined'));

    let server: http.Server | https.Server;
    if (args.tls_cert) {
        server = await createHTTPSServer(app, args.tls_cert, args.tls_key)
    } else {
        log(`Setting up a HTTP server...`);
        server = createHTTPServer(app);
        log('done.\n');
    }

    app.use('/cra.cz', await craApi(args, db, queueMgr.push));

    const addr = await startListening(server, args.listen);
    log(`HTTP${args.tls_cert ? 'S' : ''} server is listening on ${addrToString(addr)}\n`);

    if (args.user || args.group)
        dropPrivileges(args.user, args.group);

    log('Initialization complete.\n');
})().catch(abort);
