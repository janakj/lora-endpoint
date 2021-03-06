import debug from 'debug';
import userid from 'userid';
import parseCmdlineArgs from 'command-line-args';
import { promises as fs } from 'fs';
import { checkInt } from './utils';

const dbg = debug('lora:args');


export interface SockAddr {
    port     : number;
    address? : string;
}


export interface Arguments {
    mqtt_broker? : string;
    config?      : string;
    tls_cert?    : string;
    db           : string;
    group?       : number;
    tls_key?     : string;
    listen       : string | SockAddr;
    credentials? : Object;
    networks     : Object;
    user?        : number;
}


const defaults = {
    config : '/usr/local/etc/lora-endpoint.json',
    db     : '/var/local/lora-endpoint/state.db'
};


const cmdlineArgs = [
    { name : 'mqtt_broker', alias : 'b' },
    { name : 'config',      alias : 'c' },
    { name : 'tls_cert',    alias : 'C' },
    { name : 'db',          alias : 'd' },
    { name : 'group',       alias : 'g' },
    { name : 'tls_key',     alias : 'k' },
    { name : 'listen',      alias : 'l' },
    { name : 'networks',    alias : 'n' },
    { name : 'credentials', alias : 'r' },
    { name : 'user',        alias : 'u' }
];


function parseListenString(val: string) {
    // UNIX domain socket pathname
    if (val.startsWith('/')) return val;

    let address, port, next = 0;

    if (val.startsWith('[')) {
        const end = val.indexOf(']');
        if (end === -1) throw new Error('Missing closing ] in listen argument value');
        address = val.slice(1, end);
        next = end + 1;
    }

    const d = val.indexOf(':', next);
    if (d === -1) {
        port = val;
    } else {
        address = address || val.slice(0, d);
        port = val.slice(d + 1);
    }

    if (port.toLowerCase() === 'random') port = 0;

    try {
        port = checkInt(port, 0, 65535);
        const rv: any = { port };
        if (address) rv.address = address;
        return rv;
    } catch (e) {
        throw new Error(`Invalid port number: ${e.message}`);
    }
}


async function loadConfig(filename) {
    dbg(`Loading configuration file '${filename}'`);
    try {
        const rv = JSON.parse(await fs.readFile(filename, 'utf-8'));
        dbg(`Configuration file '${filename}' loaded`);
        return rv;
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        dbg(`Configuration file '${filename}' does not exist, skipping.`)
        return {};
    }
}


function loadEnvironment() {
    const rv = {};
    for (const [name, value] of Object.entries(process.env))
        if (typeof value === 'string') rv[name.toLowerCase()] = value;

    return rv;
}


function parseCredentials(cred) {
    if (cred === null)
        throw new Error("Missing 'credentials' parameter value");

    if (typeof cred === 'string') {
        try {
            // eslint-disable-next-line no-param-reassign
            cred = JSON.parse(cred);
        } catch (e) { /* empty */ }
    }

    if (typeof cred !== 'undefined' && typeof cred !== 'object')
        throw new Error("Invalid 'credentials' parameter format (JSON object expected)");

    return cred;
}


function parseUser(user) {
    if (user === null)
        throw new Error("Missing 'user' parameter value");

    if (typeof user === 'undefined') return user;

    try {
        // eslint-disable-next-line no-param-reassign
        user = checkInt(user, 0);
    } catch (error) {
        // eslint-disable-next-line no-param-reassign
        user = userid.uid(user);
    }

    return user;
}


function parseGroup(group) {
    if (group === null)
        throw new Error("Missing 'group' parameter value");

    if (typeof group === 'undefined') return group;

    try {
        // eslint-disable-next-line no-param-reassign
        group = checkInt(group, 0);
    } catch (error) {
        // eslint-disable-next-line no-param-reassign
        group = userid.gid(group);
    }

    return group;
}


export default async function loadArguments(): Promise<Arguments> {
    const cmdline = parseCmdlineArgs(cmdlineArgs);
    const env: any = loadEnvironment();

    const config = (cmdline || {}).config || env.config || defaults.config;
    if (typeof config !== 'string' && typeof config !== 'undefined')
        throw new Error(`Invalid 'config' parameter value ${config}`);

    const saved = config ? await loadConfig(config) : {};

    const args = { ...defaults, ...saved, ...env, ...cmdline };

    const names = cmdlineArgs.map(v => v.name);
    Object.keys(args).forEach(name => {
        if (names.indexOf(name) === -1) delete args[name];
    })

    if (args.mqtt_broker === null)
        throw new Error("Missing 'mqtt_broker' parameter value");

    if (typeof args.tls_cert !== 'undefined' && typeof args.tls_cert !== 'string')
        throw new Error(`Invalid 'tls_cert' parameter value '${args.tls_cert}'`);

    if (typeof args.tls_key !== 'undefined' && typeof args.tls_key !== 'string')
        throw new Error(`Invalid 'tls_key' parameter value '${args.tls_key}'`);

    if (args.db === null)
        throw new Error("Missing 'db' parameter value");

    if (typeof args.listen === 'string')
        args.listen = parseListenString(args.listen);

    if (args.listen === null)
        throw new Error("Missing 'listen' parameter value");

    if (typeof args.listen === 'undefined')
        args.listen = { port: args.tls_cert ? 443 : 80 }

    args.credentials = parseCredentials(args.credentials);
    args.user = parseUser(args.user);
    args.group = parseGroup(args.group);

    if (args.networks === null)
        throw new Error("Missing 'networks' parameter value");

    if (typeof args.networks === 'string') {
        try {
            args.networks = JSON.parse(args.networks);
        } catch (e) { /* empty */ }
    }

    if (typeof args.networks !== 'object')
        throw new Error("Invalid or missing 'networks' parameter value");

    return args as Arguments;
}
