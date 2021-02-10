/* eslint-disable react/jsx-no-bind */
import MessageDrawIcon from 'mdi-react/MessageDrawIcon'
import TickIcon from 'mdi-react/TickIcon'
import React, { useCallback, useEffect, useState } from 'react'
import TextAreaAutosize from 'react-textarea-autosize'
import { Alert, ButtonDropdown, DropdownMenu, DropdownToggle } from 'reactstrap'
import { gql } from '../../../../shared/src/graphql/graphql'
import { LoaderButton } from '../../components/LoaderButton'
import { SubmitSurveyResult, SubmitSurveyVariables } from '../../graphql-operations'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useMutation } from '../../hooks/useMutation'
import { IconRadioButtons } from '../IconRadioButtons'
import { Happy, Sad, VeryHappy, VerySad } from './FeedbackIcons'

const SUBMIT_FEEDBACK_QUERY = gql`
    mutation SubmitSurvey($input: SurveySubmissionInput!) {
        submitSurvey(input: $input) {
            alwaysNil
        }
    }
`

const SuccessMessage: React.FunctionComponent<{ showUserResearchLink: boolean; className: string }> = ({
    showUserResearchLink,
    className,
}) => (
    <div className={className}>
        <TickIcon className="feedback-prompt__success--tick" />
        <h3>We've received your feedback!</h3>
        <p className="d-inline">
            Thank you for your help.{' '}
            {showUserResearchLink && (
                <>
                    Want to help keep making Sourcegraph better?{' '}
                    <a href="/settings/product-research">Join us for occasional user research.</a> and share your
                    feedback on our latest features and ideas.
                </>
            )}
        </p>
    </div>
)

interface Props {}

export const FeedbackPrompt: React.FunctionComponent<Props> = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [text, setText] = useLocalStorage('text', '')
    const [rating, setRating] = useLocalStorage('rating', undefined)
    const [response, setResponse] = useState<SubmitSurveyResult | undefined>()

    const handleToggle = useCallback(() => setIsOpen(open => !open), [])
    const handleRateChange = useCallback(value => setRating(value), [])
    const handleTextChange = useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
        []
    )

    const [submitFeedback, { loading, data, error }] = useMutation<SubmitSurveyResult, SubmitSurveyVariables>(
        SUBMIT_FEEDBACK_QUERY
    )

    /**
     * The purpose of this effect is to reset data coming from the hook.
     * The widget allows multiple feedback requests after a successful response.
     */

    useEffect(() => {
        setResponse(data)
    }, [data])

    // Reset to initial state after a succesful response.
    useEffect(() => {
        if (response) {
            const reset = setTimeout(() => {
                setIsOpen(false)
                setText('')
                setRating(undefined)
                setResponse(undefined)
            }, 3000)

            return () => clearInterval(reset)
        }
    }, [response])

    return (
        <ButtonDropdown isOpen={isOpen} toggle={handleToggle} className="border feedback-prompt">
            <DropdownToggle
                disabled={loading} // Avoid the user close the widget while the request is processing.
                caret={false}
                className="btn btn-link text-decoration-none"
                nav={true}
                aria-label="Feedback"
            >
                <MessageDrawIcon className="d-lg-none icon-inline" />
                <span className="d-none d-lg-block">Feedback</span>
            </DropdownToggle>
            <DropdownMenu right={true} className="p-3 feedback-prompt__menu">
                {response && (
                    <SuccessMessage
                        className="feedback-prompt__success align-middle"
                        // TODO: Check if the product research page is enabled in admin settings
                        showUserResearchLink={true}
                    />
                )}
                {!response && (
                    <>
                        <h3 className="align-middle">What's on your mind?</h3>
                        <TextAreaAutosize
                            onChange={handleTextChange}
                            value={text}
                            minRows={3}
                            maxRows={6}
                            placeholder="What's going well? What could be better?"
                            className="form-control feedback-prompt__textarea"
                        />
                        <IconRadioButtons
                            name="emoji-selector"
                            icons={[
                                {
                                    name: 'Very sad',
                                    value: 1,
                                    icon: VerySad,
                                },
                                {
                                    name: 'Sad',
                                    value: 2,
                                    icon: Sad,
                                },
                                {
                                    name: 'Happy',
                                    value: 3,
                                    icon: Happy,
                                },
                                {
                                    name: 'Very Happy',
                                    value: 4,
                                    icon: VeryHappy,
                                },
                            ]}
                            selected={rating}
                            onChange={handleRateChange}
                            disabled={loading}
                        />

                        {error && (
                            <Alert className="mt-3 feedback-prompt__alert" color="danger">
                                Something went wrong while sending your feedback. Please try again.
                            </Alert>
                        )}
                        <LoaderButton
                            className="w-100 btn btn-block btn-secondary mt-3"
                            loading={loading}
                            label="Send"
                            onClick={() => submitFeedback({ input: { score: Number(rating), reason: text } })}
                            disabled={!rating}
                        />
                    </>
                )}
            </DropdownMenu>
        </ButtonDropdown>
    )
}
