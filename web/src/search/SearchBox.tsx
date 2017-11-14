import FileIcon from '@sourcegraph/icons/lib/File'
import FileGlobIcon from '@sourcegraph/icons/lib/FileGlob'
import Loader from '@sourcegraph/icons/lib/Loader'
import RepoIcon from '@sourcegraph/icons/lib/Repo'
import RepoGroupIcon from '@sourcegraph/icons/lib/RepoGroup'
import RepoQuestionIcon from '@sourcegraph/icons/lib/RepoQuestion'
import ReportIcon from '@sourcegraph/icons/lib/Report'
import SearchIcon from '@sourcegraph/icons/lib/Search'
import * as H from 'history'
import * as React from 'react'
import { matchPath } from 'react-router'
import { Observable } from 'rxjs/Observable'
import { fromEvent } from 'rxjs/observable/fromEvent'
import { merge } from 'rxjs/observable/merge'
import { of } from 'rxjs/observable/of'
import { catchError } from 'rxjs/operators/catchError'
import { debounceTime } from 'rxjs/operators/debounceTime'
import { delay } from 'rxjs/operators/delay'
import { distinctUntilChanged } from 'rxjs/operators/distinctUntilChanged'
import { filter } from 'rxjs/operators/filter'
import { map } from 'rxjs/operators/map'
import { observeOn } from 'rxjs/operators/observeOn'
import { publishReplay } from 'rxjs/operators/publishReplay'
import { refCount } from 'rxjs/operators/refCount'
import { repeat } from 'rxjs/operators/repeat'
import { skip } from 'rxjs/operators/skip'
import { startWith } from 'rxjs/operators/startWith'
import { switchMap } from 'rxjs/operators/switchMap'
import { takeUntil } from 'rxjs/operators/takeUntil'
import { tap } from 'rxjs/operators/tap'
import { toArray } from 'rxjs/operators/toArray'
import { asap } from 'rxjs/scheduler/asap'
import { Subject } from 'rxjs/Subject'
import { Subscription } from 'rxjs/Subscription'
import { routes } from '../routes'
import { eventLogger } from '../tracking/eventLogger'
import { scrollIntoView } from '../util'
import { fetchSuggestions } from './backend'
import { Chip } from './Chip'
import {
    buildSearchURLQuery,
    FileFilter,
    Filter,
    FilterType,
    parseSearchURLQuery,
    RepoFilter,
    SearchOptions,
} from './index'
import { Suggestion } from './Suggestion'

function hasMagic(value: string): boolean {
    return /^!|\*|\?/.test(value)
}

function getFilterLabel(filter: Filter): string {
    return filter.value
}

function getFilterIcon(filter: Filter): (props: {}) => JSX.Element {
    switch (filter.type) {
        case FilterType.UnknownRepo:
            return RepoQuestionIcon
        case FilterType.Repo:
            return RepoIcon
        case FilterType.RepoGroup:
            return RepoGroupIcon
        case FilterType.File:
            if (hasMagic(filter.value)) {
                return FileGlobIcon
            }
            return FileIcon
    }
}

interface Props {
    history: H.History
    location: H.Location
}

interface State extends SearchOptions {
    /** Whether suggestions are shown or not */
    suggestionsVisible: boolean

    /** The suggestions shown to the user */
    suggestions: Filter[]

    /** Index of the currently selected suggestion (-1 if none selected) */
    selectedSuggestion: number

    /** Whether suggestions are currently being fetched */
    loading: boolean
}

const shortcutModifier = navigator.platform.startsWith('Mac') ? 'Ctrl' : 'Cmd'

export class SearchBox extends React.Component<Props, State> {
    /** Subscriptions to unsubscribe from on component unmount */
    private subscriptions = new Subscription()

    /** Emits on keydown events in the input field */
    private inputKeyDowns = new Subject<React.KeyboardEvent<HTMLInputElement>>()

    /** Emits new input values */
    private inputValues = new Subject<string>()

    /** Emits when the input field is clicked */
    private inputClicks = new Subject<void>()

    /** Emits on componentWillReceiveProps */
    private componentUpdates = new Subject<Props>()

    /** Only used for focus management */
    private containerElement?: HTMLElement

    /** Only used for selection and focus management */
    private inputElement?: HTMLInputElement

    /** Only used for scroll state management */
    private suggestionListElement?: HTMLElement

    /** Only used for scroll state management */
    private selectedSuggestionElement?: HTMLElement

    /** Only used for scroll state management */
    private chipsElement?: HTMLElement

    /** Only used for event logging */
    private hasLoggedFirstChange = false

    constructor(props: Props) {
        super(props)
        // Fill text input from URL info
        this.state = this.getStateFromProps(props)

        /** Emits whenever the route changes */
        const routeChanges = this.componentUpdates.pipe(
            startWith(props),
            distinctUntilChanged((a, b) => a.location === b.location),
            skip(1)
        )

        // Reset SearchBox on route changes
        this.subscriptions.add(
            routeChanges.subscribe(
                props => {
                    this.setState(this.getStateFromProps(props))
                },
                err => {
                    console.error(err)
                }
            )
        )

        this.subscriptions.add(
            merge(
                // Trigger new suggestions every time the input field is typed into
                this.inputValues.pipe(tap(query => this.setState({ query }))),
                // Trigger new suggestions every time the input field is clicked
                this.inputClicks.pipe(map(() => this.inputElement!.value)),
                this.inputKeyDowns
                    // Defer to next tick to get the selection _after_ any selection change was dipatched (e.g. arrow keys)
                    .pipe(
                        observeOn(asap),
                        filter(event => event.key !== 'ArrowDown' && event.key !== 'ArrowUp'),
                        map(() => this.state.query)
                    )
            )
                // Only use query up to the cursor
                .pipe(
                    map(query => query.substring(0, this.inputElement!.selectionEnd)),
                    distinctUntilChanged(),
                    debounceTime(200),
                    switchMap(query => {
                        if (query.length <= 1) {
                            return [{ suggestions: [], selectedSuggestion: -1, loading: false }]
                        }
                        const suggestionsFetch = (() => {
                            // If query includes a wildcard, suggest a file glob filter
                            // TODO suggest repo glob filter (needs server implementation)
                            // TODO verify that the glob matches something server-side,
                            //      only suggest if it does and show number of matches
                            if (hasMagic(query)) {
                                const fileFilter: FileFilter = {
                                    type: FilterType.File,
                                    value: query,
                                }
                                return of(fileFilter)
                            }
                            return fetchSuggestions(query, this.state.filters).pipe(
                                map((item: GQL.SearchResult): Filter => {
                                    switch (item.__typename) {
                                        case 'Repository':
                                            return { type: FilterType.Repo, value: item.uri }
                                        case 'SearchProfile':
                                            return { type: FilterType.RepoGroup, value: item.name }
                                        case 'File':
                                            return { type: FilterType.File, value: item.name }
                                    }
                                })
                            )
                        })().pipe(
                            toArray(),
                            map(suggestions => {
                                // If no results were found, but the query looks like a repo slug (e.g. sourcegraph/icons), suggest to add it as an "unknown repo"
                                // This is meant as an escape hatch when we don't have a repo in our database so the user can still navigate to it
                                if (suggestions.length === 0 && query.includes('/')) {
                                    const filter: Filter = { type: FilterType.UnknownRepo, value: query }
                                    // Don't require typing github.com/
                                    if (!window.context.onPrem && !query.startsWith('github.com/')) {
                                        filter.value = 'github.com/' + filter.value
                                    }
                                    return [filter]
                                }
                                return suggestions
                            }),
                            map(suggestions => ({
                                suggestions,
                                selectedSuggestion: -1,
                                suggestionsVisible: true,
                                loading: false,
                            })),
                            catchError(err => {
                                console.error(err)
                                return []
                            }),
                            publishReplay(),
                            refCount()
                        )
                        return merge(
                            suggestionsFetch,
                            // Show a loader if the fetch takes longer than 100ms
                            of({ loading: true }).pipe(delay(100), takeUntil(suggestionsFetch))
                        )
                    }),
                    // Abort suggestion display on route change
                    takeUntil(routeChanges),
                    // But resubscribe afterwards
                    repeat()
                )
                .subscribe(
                    state => {
                        this.setState(state as State)
                    },
                    err => {
                        console.error(err)
                    }
                )
        )

        // Quick-Open hotkeys
        this.subscriptions.add(
            fromEvent<KeyboardEvent>(window, 'keydown')
                .pipe(
                    filter(
                        event =>
                            // Slash shortcut (if no input element is focused)
                            (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.nodeName)) ||
                            // Cmd/Ctrl+P shortcut
                            ((event.metaKey || event.ctrlKey) && event.key === 'p') ||
                            // Cmd/Ctrl+Shift+F shortcut
                            ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'f')
                    ),
                    switchMap(event => {
                        event.preventDefault()
                        // Use selection as query
                        const selection = window.getSelection().toString()
                        if (selection) {
                            return new Observable<void>(observer =>
                                this.setState(
                                    {
                                        query: selection,
                                        suggestions: [],
                                        selectedSuggestion: -1,
                                    },
                                    () => {
                                        observer.next()
                                        observer.complete()
                                    }
                                )
                            )
                        }
                        return [undefined]
                    })
                )
                .subscribe(() => {
                    if (this.inputElement) {
                        // Select all input
                        this.inputElement.focus()
                        this.inputElement.setSelectionRange(0, this.inputElement.value.length)
                    }
                })
        )

        this.subscriptions.add(
            fromEvent<MouseEvent>(document, 'click').subscribe(e => {
                if (!this.containerElement || !this.containerElement.contains(e.target as Node)) {
                    this.setState({ suggestionsVisible: false })
                }
            })
        )
    }

    public componentWillReceiveProps(newProps: Props): void {
        this.componentUpdates.next(newProps)
    }

    public componentDidMount(): void {
        this.focusInput()
    }

    public componentWillUnmount(): void {
        this.subscriptions.unsubscribe()
    }

    public componentDidUpdate(prevProps: Props, prevState: State): void {
        // Check if selected suggestion is out of view
        scrollIntoView(this.suggestionListElement, this.selectedSuggestionElement)
    }

    public render(): JSX.Element | null {
        const queryToCursor = this.inputElement
            ? this.state.query.substring(0, this.inputElement.selectionEnd)
            : this.state.query

        const showNoMatches =
            this.state.query.length > 1 &&
            !!this.state.suggestionsVisible &&
            this.state.suggestions.length === 0 &&
            this.state.filters.length === 0 &&
            !this.state.loading

        const showSuggestions =
            this.state.query.length > 1 && !!this.state.suggestionsVisible && this.state.suggestions.length !== 0

        const showSpacer = !showNoMatches && !showSuggestions

        return (
            <form
                className={
                    'search-box' +
                    (this.state.suggestionsVisible && (this.state.query || this.state.filters.length > 0)
                        ? ' search-box--suggesting'
                        : '')
                }
                onSubmit={this.onSubmit}
                ref={ref => (this.containerElement = ref || undefined)}
            >
                <div className="search-box__query">
                    {/* Search icon / Loader */}
                    <div className="search-box__search-icon">
                        {this.state.loading ? (
                            <Loader className="icon-inline" />
                        ) : (
                            <SearchIcon className="icon-inline" />
                        )}
                    </div>

                    {/* Chips */}
                    <div className="search-box__chips" ref={ref => (this.chipsElement = ref || undefined)}>
                        {this.state.filters.map((filter, i) => (
                            <Chip
                                key={i}
                                icon={getFilterIcon(filter)}
                                label={getFilterLabel(filter)}
                                // tslint:disable-next-line:jsx-no-lambda
                                onDelete={() => this.removeFilter(i)}
                            />
                        ))}
                        <input
                            type="search"
                            className="search-box__input"
                            value={this.state.query}
                            onChange={this.onInputChange}
                            onKeyDown={this.onInputKeyDown}
                            onClick={this.onInputClick}
                            spellCheck={false}
                            autoCapitalize="off"
                            placeholder="Search"
                            ref={ref => (this.inputElement = ref!)}
                        />
                    </div>
                    <label className="search-box__option" title={`Match case (${shortcutModifier}+C)`}>
                        <input type="checkbox" checked={this.state.matchCase} onChange={this.toggleMatchCase} />
                        <span>Aa</span>
                    </label>
                    <label className="search-box__option" title={`Match whole word (${shortcutModifier}+W)`}>
                        <input type="checkbox" checked={this.state.matchWord} onChange={this.toggleMatchWord} />
                        <span>
                            <u>Ab</u>
                        </span>
                    </label>
                    <label className="search-box__option" title={`Match regular expression (${shortcutModifier}+R)`}>
                        <input type="checkbox" checked={this.state.matchRegex} onChange={this.toggleMatchRegex} />
                        <span>.*</span>
                    </label>
                </div>
                {showSpacer && <div className="search-box__spacer" />}
                {showNoMatches && (
                    <div className="search-box__no-matches">
                        <ReportIcon className="icon-inline" />
                        <div className="search-box__no-matches-text">No matches</div>
                    </div>
                )}

                {/* Suggestions */}
                {showSuggestions && (
                    <ul className="search-box__suggestions" ref={this.setSuggestionListElement}>
                        {this.state.suggestions.map((suggestion, i) => {
                            const isSelected = this.state.selectedSuggestion === i
                            const onRef = (ref: HTMLLIElement | null) => {
                                if (isSelected) {
                                    this.selectedSuggestionElement = ref || undefined
                                }
                            }
                            return (
                                <Suggestion
                                    key={i}
                                    icon={getFilterIcon(suggestion)}
                                    label={getFilterLabel(suggestion)}
                                    query={queryToCursor}
                                    isSelected={isSelected}
                                    // tslint:disable-next-line:jsx-no-lambda
                                    onClick={() => this.selectSuggestion(suggestion, '')}
                                    liRef={onRef}
                                />
                            )
                        })}
                    </ul>
                )}
            </form>
        )
    }

    private toggleMatchCase = () => this.setState({ matchCase: !this.state.matchCase })
    private toggleMatchWord = () => this.setState({ matchWord: !this.state.matchWord })
    private toggleMatchRegex = () => this.setState({ matchRegex: !this.state.matchRegex })

    private setSuggestionListElement = (ref: HTMLElement | null): void => {
        this.suggestionListElement = ref || undefined
    }

    private selectSuggestion = (suggestion: Filter, newQuery: string): void => {
        eventLogger.log('SearchSuggestionSelected', {
            code_search: {
                suggestion: {
                    type: suggestion.type,
                    value: suggestion.value,
                },
            },
        })
        this.setState(
            prevState => ({
                filters: prevState.filters.concat(suggestion),
                suggestions: [],
                selectedSuggestion: -1,
                query: newQuery,
            }),
            () => {
                // Scroll chips so search input stays visible
                if (this.chipsElement) {
                    this.chipsElement.scrollLeft = this.chipsElement.scrollWidth
                }
            }
        )
    }

    private focusInput(): void {
        if (this.inputElement) {
            // Focus the input element and set cursor to the end
            this.inputElement.focus()
            this.inputElement.setSelectionRange(this.inputElement.value.length, this.inputElement.value.length)
        }
    }

    /**
     * Reads initial state from the props (i.e. URL parameters)
     */
    private getStateFromProps(props: Props): State {
        let searchOptions: SearchOptions = {
            query: '',
            filters: [],
            matchCase: false,
            matchWord: false,
            matchRegex: false,
        }
        // This is basically a programmatical <Switch> with <Route>s
        // see https://reacttraining.com/react-router/web/api/matchPath
        // and https://reacttraining.com/react-router/web/example/sidebar
        for (const route of routes) {
            const match = matchPath<{ repoRev?: string; filePath?: string }>(props.location.pathname, route)
            if (match) {
                switch (match.path) {
                    case '/search': {
                        // Search results page, show query
                        searchOptions = parseSearchURLQuery(props.location.search)
                        break
                    }
                    case '/:repoRev+': {
                        // Repo page, add repo filter
                        const [repoPath] = match.params.repoRev!.split('@')
                        searchOptions.filters.push({ type: FilterType.Repo, value: repoPath })
                        break
                    }
                    case '/:repoRev+/-/blob/:filePath+': {
                        // Blob page, add file filter
                        const [repoPath] = match.params.repoRev!.split('@')
                        searchOptions.filters.push({ type: FilterType.Repo, value: repoPath! })
                        searchOptions.filters.push({ type: FilterType.File, value: match.params.filePath! })
                        break
                    }
                }
                break
            }
        }

        return { ...searchOptions, suggestions: [], selectedSuggestion: -1, suggestionsVisible: false, loading: false }
    }

    private removeFilter(index: number): void {
        const { filters } = this.state
        filters.splice(index, 1)
        this.setState({ filters })
    }

    private onInputChange: React.ChangeEventHandler<HTMLInputElement> = event => {
        if (!this.hasLoggedFirstChange) {
            eventLogger.log('SearchInitiated')
            this.hasLoggedFirstChange = true
        }
        this.inputValues.next(event.currentTarget.value)
    }

    private onInputClick: React.MouseEventHandler<HTMLInputElement> = event => {
        this.inputClicks.next()
    }

    private onInputKeyDown: React.KeyboardEventHandler<HTMLInputElement> = event => {
        event.persist()
        this.inputKeyDowns.next(event)
        switch (event.key) {
            case 'ArrowDown': {
                event.preventDefault()
                this.moveSelection(1)
                break
            }
            case 'ArrowUp': {
                event.preventDefault()
                this.moveSelection(-1)
                break
            }
            case 'Enter': {
                if (this.state.selectedSuggestion === -1) {
                    // Submit form
                    break
                }
                // fall through
            }
            case 'Tab': {
                event.preventDefault()
                if (this.state.suggestions.length === 0) {
                    break
                }
                this.selectSuggestion(
                    this.state.suggestions[Math.max(this.state.selectedSuggestion, 0)],
                    this.state.query.substr(event.currentTarget.selectionEnd)
                )
                break
            }
            case 'Backspace': {
                if (this.inputElement!.selectionStart === 0 && this.inputElement!.selectionEnd === 0) {
                    this.setState({ filters: this.state.filters.slice(0, -1) })
                }
                break
            }
            case 'r': {
                if (event.ctrlKey || event.metaKey) {
                    this.setState(prevState => ({ matchRegex: !prevState.matchRegex }))
                }
                break
            }
            case 'w': {
                if (event.ctrlKey || event.metaKey) {
                    this.setState(prevState => ({ matchWord: !prevState.matchWord }))
                }
                break
            }
            case 'c': {
                if (event.ctrlKey || event.metaKey) {
                    this.setState(prevState => ({ matchCase: !prevState.matchCase }))
                }
                break
            }
        }
    }

    private moveSelection(steps: number): void {
        this.setState({
            selectedSuggestion: Math.max(
                Math.min(this.state.selectedSuggestion + steps, this.state.suggestions.length - 1),
                -1
            ),
        })
    }

    /**
     * Called when the user submits the form (by pressing Enter)
     * If only one repo was selected and no query typed, redirects to the repo page
     * Otherwise redirects to the search results page
     */
    private onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
        event.preventDefault()
        this.setState({ suggestionsVisible: false })
        if (this.state.filters.length === 0) {
            return
        }
        if (this.state.query) {
            // Go to search results
            const path = '/search?' + buildSearchURLQuery(this.state)
            eventLogger.log('SearchSubmitted', {
                code_search: {
                    pattern: this.state.query,
                    repos: this.state.filters
                        .filter((f: Filter): f is RepoFilter => f.type === FilterType.Repo)
                        .map(f => f.value),
                },
            })
            this.props.history.push(path)
        } else if (
            this.state.filters[0].type === FilterType.Repo ||
            this.state.filters[0].type === FilterType.UnknownRepo
        ) {
            if (this.state.filters.length === 1) {
                // Go to repo
                eventLogger.log('SearchGoToRepoSubmitted')
                this.props.history.push(`/${(this.state.filters[0] as RepoFilter).value}`)
            } else if (
                this.state.filters[1].type === FilterType.File &&
                this.state.filters.length === 2 &&
                !hasMagic(this.state.filters[1].value)
            ) {
                // Go to file
                const [repoFilter, fileFilter] = this.state.filters as [RepoFilter, FileFilter]
                eventLogger.log('SearchGoToFileSubmitted')
                this.props.history.push(`/${repoFilter.value}/-/blob/${fileFilter.value}`)
            }
        }
    }
}
