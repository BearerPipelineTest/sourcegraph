package reposource

import (
	"strings"

	"golang.org/x/mod/module"

	"github.com/sourcegraph/sourcegraph/internal/api"
)

// GoDependency is a "versioned package" for use by go commands, such as `go
// get`.
//
// See also: [NOTE: Dependency-terminology]
type GoDependency struct {
	Module module.Version
}

// NewGoDependency returns a GoDependency for the given module.Version.
func NewGoDependency(v module.Version) *GoDependency {
	return &GoDependency{Module: v}
}

// ParseGoDependency parses a string in a '<name>@<version>' format into an
// GoDependency.
func ParseGoDependency(dependency string) (*GoDependency, error) {
	var v module.Version
	if i := strings.LastIndex(dependency, "@"); i == -1 {
		v.Path = dependency
	} else {
		v.Path = dependency[:i]
		v.Version = dependency[i+1:]
	}

	var err error
	if v.Version != "" {
		err = module.Check(v.Path, v.Version)
	} else {
		err = module.CheckPath(v.Path)
	}

	if err != nil {
		return nil, err
	}

	return &GoDependency{Module: v}, nil
}

// ParseGoDependencyFromRepoName is a convenience function to parse a repo name in a
// 'go/mod(@version)?' format into a GoDependency.
func ParseGoDependencyFromRepoName(name string) (*GoDependency, error) {
	return ParseGoDependency(strings.TrimPrefix(name, "go/"))
}

func (d *GoDependency) Scheme() string {
	return "go"
}

// PackageSyntax returns the name of the Go module.
func (d *GoDependency) PackageSyntax() string {
	return d.Module.Path
}

// PackageManagerSyntax returns the dependency in Go syntax. The returned string
// can (for example) be passed to `go get`.
func (d *GoDependency) PackageManagerSyntax() string {
	return d.Module.String()
}

func (d *GoDependency) PackageVersion() string {
	return d.Module.Version
}

// RepoName provides a name that is "globally unique" for a Sourcegraph instance.
//
// The returned value is used for repo:... in queries.
func (d *GoDependency) RepoName() api.RepoName {
	return api.RepoName("go/" + d.Module.Path)
}

func (d *GoDependency) GitTagFromVersion() string {
	return d.Module.Version
}

func (d *GoDependency) Equal(other *GoDependency) bool {
	return d == other || (d != nil && other != nil && d.Module == other.Module)
}
