/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseHttpRequest } from './core/BaseHttpRequest';
import type { OpenAPIConfig } from './core/OpenAPI';
import { NodeHttpRequest } from './core/NodeHttpRequest';
import { AuthService } from './services/AuthService';
import { CollectionService } from './services/CollectionService';
import { IssueService } from './services/IssueService';
import { MediaService } from './services/MediaService';
import { MoviesService } from './services/MoviesService';
import { OtherService } from './services/OtherService';
import { PersonService } from './services/PersonService';
import { PublicService } from './services/PublicService';
import { RequestService } from './services/RequestService';
import { SearchService } from './services/SearchService';
import { ServiceService } from './services/ServiceService';
import { SettingsService } from './services/SettingsService';
import { TmdbService } from './services/TmdbService';
import { TvService } from './services/TvService';
import { UsersService } from './services/UsersService';
type HttpRequestConstructor = new (config: OpenAPIConfig) => BaseHttpRequest;
export class OverseerrClient {
    public readonly auth: AuthService;
    public readonly collection: CollectionService;
    public readonly issue: IssueService;
    public readonly media: MediaService;
    public readonly movies: MoviesService;
    public readonly other: OtherService;
    public readonly person: PersonService;
    public readonly public: PublicService;
    public readonly request: RequestService;
    public readonly search: SearchService;
    public readonly service: ServiceService;
    public readonly settings: SettingsService;
    public readonly tmdb: TmdbService;
    public readonly tv: TvService;
    public readonly users: UsersService;
    public readonly request: BaseHttpRequest;
    constructor(config?: Partial<OpenAPIConfig>, HttpRequest: HttpRequestConstructor = NodeHttpRequest) {
        this.request = new HttpRequest({
            BASE: config?.BASE ?? 'http://localhost:5055/api/v1',
            VERSION: config?.VERSION ?? '1.0.0',
            WITH_CREDENTIALS: config?.WITH_CREDENTIALS ?? false,
            CREDENTIALS: config?.CREDENTIALS ?? 'include',
            TOKEN: config?.TOKEN,
            USERNAME: config?.USERNAME,
            PASSWORD: config?.PASSWORD,
            HEADERS: config?.HEADERS,
            ENCODE_PATH: config?.ENCODE_PATH,
        });
        this.auth = new AuthService(this.request);
        this.collection = new CollectionService(this.request);
        this.issue = new IssueService(this.request);
        this.media = new MediaService(this.request);
        this.movies = new MoviesService(this.request);
        this.other = new OtherService(this.request);
        this.person = new PersonService(this.request);
        this.public = new PublicService(this.request);
        this.request = new RequestService(this.request);
        this.search = new SearchService(this.request);
        this.service = new ServiceService(this.request);
        this.settings = new SettingsService(this.request);
        this.tmdb = new TmdbService(this.request);
        this.tv = new TvService(this.request);
        this.users = new UsersService(this.request);
    }
}

