import EventEmitter from 'events';

import debug from 'debug';
import invariant from 'invariant';
import pMap from 'p-map';

import CacheBasedSessionStore from '../session/CacheBasedSessionStore';
import Context from '../context/Context';
import MemoryCacheStore from '../cache/MemoryCacheStore';
import Session from '../session/Session';
import SessionStore from '../session/SessionStore';

import { Connector } from './Connector';

type FunctionalHandler = (
  context: Context,
  otherArg?: any
) => void | Promise<void>;

type Builder = {
  build: () => FunctionalHandler;
};

const debugRequest = debug('bottender:request');
const debugResponse = debug('bottender:response');
const debugSessionRead = debug('bottender:session:read');
const debugSessionWrite = debug('bottender:session:write');
const debugDialog = debug('bottender:dialog');

const MINUTES_IN_ONE_YEAR = 365 * 24 * 60;

function createMemorySessionStore(): SessionStore {
  const cache = new MemoryCacheStore(500);
  return new CacheBasedSessionStore(cache, MINUTES_IN_ONE_YEAR);
}

function run(fn: FunctionalHandler): FunctionalHandler {
  return async function Run(context): Promise<void> {
    let nextDialog: FunctionalHandler | void = fn;

    do {
      // TODO: improve this debug helper
      debugDialog(`Current Dialog: ${nextDialog.name || 'Anonymous'}`);
      // eslint-disable-next-line no-await-in-loop
      nextDialog = await nextDialog(context);
    } while (typeof nextDialog === 'function');

    return nextDialog;
  };
}

type RequestHandler<B> = (
  body: B,
  requestContext?: Record<string, any> | null
) => void | Promise<void>;

type ErrorHandler = (err: Error, ctx?: Context) => void | Promise<void>;

export default class Bot<B, C> {
  _sessions: SessionStore;

  _initialized: boolean;

  _connector: Connector<B, C>;

  _handler: FunctionalHandler | null;

  _initialState: Record<string, any> = {};

  _plugins: Function[] = [];

  _sync: boolean;

  _emitter: EventEmitter;

  constructor({
    connector,
    sessionStore = createMemorySessionStore(),
    sync = false,
  }: {
    connector: Connector<B, C>;
    sessionStore?: SessionStore;
    sync?: boolean;
  }) {
    this._sessions = sessionStore;
    this._initialized = false;
    this._connector = connector;
    this._handler = null;
    this._sync = sync;
    this._emitter = new EventEmitter();
  }

  get connector(): Connector<B, C> {
    return this._connector;
  }

  get sessions(): SessionStore {
    return this._sessions;
  }

  get handler(): FunctionalHandler | null {
    return this._handler;
  }

  get emitter(): EventEmitter {
    return this._emitter;
  }

  onEvent(handler: FunctionalHandler | Builder): Bot<B, C> {
    invariant(
      handler,
      'onEvent: Can not pass `undefined`, `null` or any falsy value as handler'
    );
    this._handler = 'build' in handler ? handler.build() : handler;
    return this;
  }

  onError(handler: ErrorHandler | Builder): Bot<B, C> {
    // FIXME: [type]
    this._emitter.on('error', 'build' in handler ? handler.build() : handler);
    return this;
  }

  setInitialState(initialState: Record<string, any>): Bot<B, C> {
    this._initialState = initialState;
    return this;
  }

  use(fn: Function): Bot<B, C> {
    this._plugins.push(fn);
    return this;
  }

  async initSessionStore(): Promise<void> {
    if (!this._initialized) {
      await this._sessions.init();
      this._initialized = true;
    }
  }

  createRequestHandler(): RequestHandler<B> {
    if (this._handler == null) {
      throw new Error(
        'Bot: Missing event handler function. You should assign it using onEvent(...)'
      );
    }

    if (!this._emitter.listenerCount('error')) {
      this._emitter.on('error', console.error);
    }

    return async (body: B, requestContext?: Record<string, any> | null) => {
      if (!body) {
        throw new Error('Bot.createRequestHandler: Missing argument.');
      }

      debugRequest('Incoming request body:');
      debugRequest(JSON.stringify(body, null, 2));

      await this.initSessionStore();

      const { platform } = this._connector;
      const sessionKey = this._connector.getUniqueSessionKey(
        body,
        requestContext
      );

      // Create or retrieve session if possible
      let sessionId: string | undefined;
      let session: Session | undefined;
      if (sessionKey) {
        sessionId = `${platform}:${sessionKey}`;

        session =
          (await this._sessions.read(sessionId)) ||
          (Object.create(null) as Session);

        debugSessionRead(`Read session: ${sessionId}`);
        debugSessionRead(JSON.stringify(session, null, 2));

        Object.defineProperty(session, 'id', {
          configurable: false,
          enumerable: true,
          writable: false,
          value: session.id || sessionId,
        });

        if (!session.platform) session.platform = platform;

        Object.defineProperty(session, 'platform', {
          configurable: false,
          enumerable: true,
          writable: false,
          value: session.platform,
        });

        await this._connector.updateSession(session, body);
      }

      const events = this._connector.mapRequestToEvents(body);

      const contexts = await pMap(
        events,
        event =>
          this._connector.createContext({
            event,
            session,
            initialState: this._initialState,
            requestContext,
            emitter: this._emitter,
          }),
        {
          concurrency: 5,
        }
      );

      // Call all of extension functions before passing to handler.
      contexts.forEach(context => {
        this._plugins.forEach(ext => {
          ext(context);
        });
      });

      if (this._handler == null) {
        throw new Error(
          'Bot: Missing event handler function. You should assign it using onEvent(...)'
        );
      }
      const handler: FunctionalHandler = this._handler;
      const promises = Promise.all(
        contexts.map(context =>
          Promise.resolve()
            .then(() => run(handler)(context))
            .then(() => {
              if (context.handlerDidEnd) {
                return context.handlerDidEnd();
              }
            })
            .catch(err => {
              context.emitError(err);
              throw err;
            })
        )
      );

      if (this._sync) {
        try {
          await promises;
          if (sessionId && session) {
            session.lastActivity = Date.now();
            contexts.forEach(context => {
              context.isSessionWritten = true;
            });

            debugSessionWrite(`Write session: ${sessionId}`);
            debugSessionWrite(JSON.stringify(session, null, 2));

            await this._sessions.write(sessionId, session);
          }
        } catch (err) {
          console.error(err);
        }

        // TODO: Any chances to merge multiple responses from context?
        const response = contexts[0].response;
        if (response && typeof response === 'object') {
          debugResponse('Outgoing response:');
          debugResponse(JSON.stringify(response, null, 2));
        }
        return response;
      }
      promises
        .then((): Promise<any> | void => {
          if (sessionId && session) {
            // $FlowFixMe: suppressing this error until we can refactor
            session.lastActivity = Date.now();
            contexts.forEach(context => {
              context.isSessionWritten = true;
            });

            debugSessionWrite(`Write session: ${sessionId}`);
            debugSessionWrite(JSON.stringify(session, null, 2));

            return this._sessions.write(sessionId, session);
          }
        })
        .catch(console.error);
    };
  }
}
