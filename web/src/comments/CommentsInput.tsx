import ErrorIcon from '@sourcegraph/icons/lib/Error'
import * as React from 'react'
import reactive from 'rx-component'
import { merge } from 'rxjs/observable/merge'
import { catchError } from 'rxjs/operators/catchError'
import { map } from 'rxjs/operators/map'
import { mergeMap } from 'rxjs/operators/mergeMap'
import { scan } from 'rxjs/operators/scan'
import { tap } from 'rxjs/operators/tap'
import { withLatestFrom } from 'rxjs/operators/withLatestFrom'
import { Subject } from 'rxjs/Subject'
import { eventLogger } from '../tracking/eventLogger'
import { addCommentToThread } from './backend'

interface Props {
    editorURL: string
    onOpenEditor: () => void
    onThreadUpdated: (updatedThread: GQL.ISharedItemThread) => void
    threadID: number
    ulid: string
}

interface State {
    editorURL: string
    onOpenEditor: () => void
    textAreaValue: string
    submitting: boolean
    error?: any
}

type Update = (s: State) => State

export const CommentsInput = reactive<Props>(props => {
    const submits = new Subject<React.FormEvent<HTMLFormElement>>()
    const nextSubmit = (e: React.FormEvent<HTMLFormElement>) => submits.next(e)

    const textAreaChanges = new Subject<string>()
    const nextTextAreaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        textAreaChanges.next(e.currentTarget.value)

    return merge(
        props.pipe(map(({ editorURL, onOpenEditor }): Update => state => ({ ...state, editorURL, onOpenEditor }))),

        textAreaChanges.pipe(map((textAreaValue): Update => state => ({ ...state, textAreaValue }))),

        // Prevent default and set submitting = true when submits occur.
        submits.pipe(
            tap(e => e.preventDefault()),
            tap(e => eventLogger.log('RepliedToThread')),
            map((): Update => state => ({ ...state, submitting: true }))
        ),

        // Add comment to thread when submits occur.
        submits.pipe(
            withLatestFrom(textAreaChanges, props),
            mergeMap(([, textAreaValue, props]) =>
                addCommentToThread(props.threadID, textAreaValue, props.ulid).pipe(
                    tap(updatedThread => props.onThreadUpdated(updatedThread)),
                    map((updatedThread): Update => state => ({ ...state, submitting: false, textAreaValue: '' })),
                    catchError((error): Update[] => {
                        console.error(error)
                        return [state => ({ ...state, error, submitting: false })]
                    })
                )
            )
        )
    ).pipe(
        scan<Update, State>((state: State, update: Update) => update(state), {} as State),
        map(({ editorURL, onOpenEditor, textAreaValue, submitting, error }: State): JSX.Element | null => (
            <form className="comments-input" onSubmit={nextSubmit}>
                <textarea
                    className="ui-text-box comments-input__text-box"
                    placeholder="Leave a comment..."
                    autoFocus={true}
                    onChange={nextTextAreaChange}
                    value={textAreaValue}
                />
                <div className="comments-input__bottom-container">
                    {error && (
                        <span className="comments-input__error">
                            <ErrorIcon className="icon-inline comments-input__error-icon" />
                            {error.message}
                        </span>
                    )}
                    {!error && <span className="comments-input__markdown-supported">Markdown supported.</span>}
                    <a className="btn btn-primary comments-input__button" href={editorURL} onClick={onOpenEditor}>
                        Open in Sourcegraph Editor
                    </a>
                    <button type="submit" className="btn btn-primary comments-input__button" disabled={submitting}>
                        Comment
                    </button>
                </div>
            </form>
        ))
    )
})
