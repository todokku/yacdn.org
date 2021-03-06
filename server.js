/* eslint curly: 0 */
const fs = require('fs');
const {URL} = require('url');
const Koa = require('koa');
const Router = require('koa-router');
const axios = require('axios');
const prettyBytes = require('pretty-bytes');
const debug = require('debug')('yacdn:server');
const Nile = require('nile');

const config = require('./config');
const redis = require('./lib/redis');
const Cache = require('./lib/Cache');
const nodes = require('./nodes');

const cache = new Cache();
const app = new Koa();
const router = new Router();

const nile = new Nile('yacdn.org');

const blacklist = (() => {
	const file = fs.readFileSync(`${__dirname}/blacklist.txt`, 'utf8');

	return file.trim().split('\n').filter(domain => domain.length > 0);
})();

debug('blacklist', blacklist);

app.use(async (ctx, next) => {
	ctx.set('Access-Control-Allow-Origin', '*');

	try {
		await next();
	} catch (error) {
		console.log(error);
		ctx.status = 500;
		ctx.body = 'Internal Server Error';
	}
});

app.use(async (ctx, next) => {
	ctx.log = {};

	await next();

	console.log(ctx.log);
	nile.pushChunk('server', JSON.stringify(ctx.log));
});

app.use(async (ctx, next) => {
	if (ctx.path === '/')
		return ctx.redirect('https://ovsoinc.github.io/yacdn.org');

	await next();
});

app.use(async (ctx, next) => {
	const startTime = Date.now();

	const servePath = '/serve/';
	const proxyPath = '/proxy/';

	if ((!ctx.path.startsWith(servePath)) && (!ctx.path.startsWith(proxyPath))) {
		return next();
	}

	const route = ctx.path.startsWith(servePath) ? 'serve' : 'proxy';

	ctx.log.n = await redis.incr('cdnhits');

	const url = `${ctx.path.slice(servePath.length)}?${route === 'proxy' ? ctx.querystring : ''}`;

	ctx.log.url = url;

	ctx.log.referer = ctx.request.headers.referer;

	if (typeof ctx.request.headers.referer === 'string') {
		const {hostname} = new URL(ctx.request.headers.referer);

		// ctx.debug('hostname', hostname, blacklist);

		/* istanbul ignore next */
		if (blacklist.includes(hostname)) {
			throw new Error('Hostname on blacklist');
		}
	}

	// increment link counter
	await redis.zincrby('serveurls', 1, url);

	const defaultMaxAge = route === 'serve' ? 24 * 60 * 60 * 1000 : 0;
	const maxAge = route === 'serve' && typeof ctx.query.maxAge === 'string' ? Number(ctx.query.maxAge) * 1000 : defaultMaxAge;

	const {
		contentLength,
		contentType,
		data
	} = await cache.retrieve(url, maxAge);

	ctx.log.size = prettyBytes(contentLength);

	ctx.set('Content-Length', contentLength);
	ctx.set('Content-Type', contentType);
	ctx.body = data;

	await redis.incrby('cdndata', contentLength);

	const time = Date.now() - startTime;
	const speed = (contentLength * 8) / (time / 1000);

	// await new Promise(resolve => data.once('end', resolve));

	ctx.log.time = `${time}ms`;
	ctx.log.speed = `${prettyBytes(speed, {bits: true})}/s`;
});

app.use(async (ctx, next) => {
	const servePath = '/stats';

	/* istanbul ignore next */
	if (!ctx.path.startsWith(servePath))
		return next();

	ctx.body = {
		cdnHits: Number(await redis.get('cdnhits')),
		cdnData: Number(await redis.get('cdndata')),
		cacheStorageUsage: Number(await redis.get('cache-storage-usage'))
	};
});

app.use(async (ctx, next) => {
	const servePath = '/global-stats';

	/* istanbul ignore next */
	if (!ctx.path.startsWith(servePath))
		return next();

	const nodeStats = await Promise.all(nodes.map(async node => {
		const {data} = await axios.get(`${node.url}/stats`);
		return data;
	}));

	const stats = nodeStats.reduce((a, b) => {
		a.cdnHits += b.cdnHits;
		a.cdnData += b.cdnData;
		a.cacheStorageUsage += b.cacheStorageUsage;

		return a;
	});

	ctx.body = {
		cdnHits: stats.cdnHits,
		cdnData: prettyBytes(stats.cdnData),
		cacheStorageUsage: prettyBytes(stats.cacheStorageUsage)
	};
});

(async () => {
	for (const {url, longitude, latitude} of nodes) {
		await redis.geoadd('nodes', longitude, latitude, url);
	}
})();

router.get('/nodes', async ctx => {
	/* istanbul ignore next */
	const ip = typeof ctx.headers['x-forwarded-for'] === 'string' ? ctx.headers['x-forwarded-for'] : ctx.ip;

	debug('ip', ip);

	const {
		data: {
			longitude,
			latitude
		}
	} = await axios.get(`http://api.ipstack.com/${ip}`, {
		params: {
			access_key: config.ipstackKey
		}
	});

	debug('longitude', longitude, 'latitude', latitude);

	const n = 5;

	ctx.body = JSON.stringify(
		(await redis.georadius('nodes', longitude, latitude, '+inf', 'km', 'WITHDIST', 'COUNT', n, 'ASC'))
			.map(([url, distance]) => ({url, distance}))
	);
});

app.use(router.routes());

/* istanbul ignore next */
// Start the server, if running this script alone
const port = process.env.PORT || 3000;

/* istanbul ignore next */
if (require.main === module) {
	app.listen(port, () => {
		debug(`Server listening on port ${port}...`);
	});
}

module.exports = app;
