package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	gogithub "github.com/sourcegraph/go-github/github"
	"sourcegraph.com/sourcegraph/sourcegraph/api/sourcegraph"
	"sourcegraph.com/sourcegraph/sourcegraph/services/backend"
	"sourcegraph.com/sourcegraph/sourcegraph/services/repoupdater"
)

func serveRepoWebhookEnable(w http.ResponseWriter, r *http.Request) error {
	var opt sourcegraph.RepoWebhookOptions
	if err := schemaDecoder.Decode(&opt, r.URL.Query()); err != nil {
		return err
	}
	if len(opt.URI) == 0 {
		return errors.New("empty URI")
	}

	_, err := backend.Repos.EnableWebhook(r.Context(), &opt)
	if err != nil {
		return err
	}

	return nil
}

func serveRepoWebhookCallback(w http.ResponseWriter, r *http.Request) error {
	payload := new(gogithub.WebHookPayload)
	if err := json.NewDecoder(r.Body).Decode(payload); err != nil {
		return err
	}

	uri := "github.com/" + *payload.Repo.FullName
	repoID, err := getRepoID(r.Context(), repoIDOrPath(uri))
	if err != nil {
		return err
	}

	if payload.After == nil {
		return nil
	}

	repoupdater.ForceEnqueue(repoID, nil)
	return nil
}
