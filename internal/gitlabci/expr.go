package gitlabci

// EvalExpr evaluates a GitLab CI rules:if expression against a variable map.
// Supports: $VAR, "string", null, ==, !=, =~, !~, &&, ||, !, ()
import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

type tokKind int

const (
	tkVar tokKind = iota
	tkStr
	tkNull
	tkEq
	tkNeq
	tkMatch
	tkNotMatch
	tkAnd
	tkOr
	tkNot
	tkLParen
	tkRParen
	tkRegex
	tkEOF
)

type tok struct {
	kind tokKind
	val  string
}

type lexer struct {
	in  []rune
	pos int
}

func newLexer(s string) *lexer { return &lexer{in: []rune(strings.TrimSpace(s))} }


func (l *lexer) skipWS() {
	for l.pos < len(l.in) && unicode.IsSpace(l.in[l.pos]) {
		l.pos++
	}
}

func (l *lexer) next() tok {
	l.skipWS()
	if l.pos >= len(l.in) {
		return tok{tkEOF, ""}
	}

	ch := l.in[l.pos]

	switch ch {
	case '$':
		l.pos++
		start := l.pos
		for l.pos < len(l.in) && (unicode.IsLetter(l.in[l.pos]) || unicode.IsDigit(l.in[l.pos]) || l.in[l.pos] == '_') {
			l.pos++
		}
		return tok{tkVar, string(l.in[start:l.pos])}

	case '"', '\'':
		q := ch
		l.pos++
		var sb strings.Builder
		for l.pos < len(l.in) && l.in[l.pos] != q {
			if l.in[l.pos] == '\\' {
				l.pos++
				if l.pos < len(l.in) {
					sb.WriteRune(l.in[l.pos])
					l.pos++
				}
			} else {
				sb.WriteRune(l.in[l.pos])
				l.pos++
			}
		}
		if l.pos < len(l.in) {
			l.pos++
		}
		return tok{tkStr, sb.String()}

	case '/':
		l.pos++
		var sb strings.Builder
		for l.pos < len(l.in) && l.in[l.pos] != '/' {
			if l.in[l.pos] == '\\' {
				l.pos++
				if l.pos < len(l.in) {
					sb.WriteRune('\\')
					sb.WriteRune(l.in[l.pos])
					l.pos++
				}
			} else {
				sb.WriteRune(l.in[l.pos])
				l.pos++
			}
		}
		if l.pos < len(l.in) {
			l.pos++
		}
		return tok{tkRegex, sb.String()}

	case '=':
		l.pos++
		if l.pos < len(l.in) {
			switch l.in[l.pos] {
			case '=':
				l.pos++
				return tok{tkEq, "=="}
			case '~':
				l.pos++
				return tok{tkMatch, "=~"}
			}
		}
		return tok{tkEOF, "="}

	case '!':
		l.pos++
		if l.pos < len(l.in) {
			switch l.in[l.pos] {
			case '=':
				l.pos++
				return tok{tkNeq, "!="}
			case '~':
				l.pos++
				return tok{tkNotMatch, "!~"}
			}
		}
		return tok{tkNot, "!"}

	case '&':
		l.pos++
		if l.pos < len(l.in) && l.in[l.pos] == '&' {
			l.pos++
			return tok{tkAnd, "&&"}
		}
		return tok{tkEOF, "&"}

	case '|':
		l.pos++
		if l.pos < len(l.in) && l.in[l.pos] == '|' {
			l.pos++
			return tok{tkOr, "||"}
		}
		return tok{tkEOF, "|"}

	case '(':
		l.pos++
		return tok{tkLParen, "("}

	case ')':
		l.pos++
		return tok{tkRParen, ")"}

	default:
		start := l.pos
		for l.pos < len(l.in) && !unicode.IsSpace(l.in[l.pos]) &&
			l.in[l.pos] != '=' && l.in[l.pos] != '!' &&
			l.in[l.pos] != '(' && l.in[l.pos] != ')' &&
			l.in[l.pos] != '&' && l.in[l.pos] != '|' {
			l.pos++
		}
		word := string(l.in[start:l.pos])
		if strings.EqualFold(word, "null") {
			return tok{tkNull, "null"}
		}
		return tok{tkStr, word}
	}
}

// ----

type exprVal struct {
	s    string
	null bool
}

func truthy(v exprVal) bool { return !v.null && v.s != "" }

type exprParser struct {
	l   *lexer
	cur tok
	env map[string]string
}

func newExprParser(expr string, env map[string]string) *exprParser {
	p := &exprParser{l: newLexer(expr), env: env}
	p.cur = p.l.next()
	return p
}

func (p *exprParser) advance() { p.cur = p.l.next() }

// EvalExpr evaluates a GitLab rules:if expression.
func EvalExpr(expr string, env map[string]string) (bool, error) {
	if strings.TrimSpace(expr) == "" {
		return true, nil
	}
	p := newExprParser(expr, env)
	v, err := p.parseOr()
	if err != nil {
		return false, err
	}
	return truthy(v), nil
}

func (p *exprParser) parseOr() (exprVal, error) {
	left, err := p.parseAnd()
	if err != nil {
		return exprVal{}, err
	}
	for p.cur.kind == tkOr {
		p.advance()
		right, err := p.parseAnd()
		if err != nil {
			return exprVal{}, err
		}
		if truthy(left) || truthy(right) {
			left = exprVal{s: "true"}
		} else {
			left = exprVal{null: true}
		}
	}
	return left, nil
}

func (p *exprParser) parseAnd() (exprVal, error) {
	left, err := p.parseCmp()
	if err != nil {
		return exprVal{}, err
	}
	for p.cur.kind == tkAnd {
		p.advance()
		right, err := p.parseCmp()
		if err != nil {
			return exprVal{}, err
		}
		if truthy(left) && truthy(right) {
			left = exprVal{s: "true"}
		} else {
			left = exprVal{null: true}
		}
	}
	return left, nil
}

func (p *exprParser) parseCmp() (exprVal, error) {
	if p.cur.kind == tkNot {
		p.advance()
		v, err := p.parseCmp()
		if err != nil {
			return exprVal{}, err
		}
		if truthy(v) {
			return exprVal{null: true}, nil
		}
		return exprVal{s: "true"}, nil
	}

	left, err := p.parseAtom()
	if err != nil {
		return exprVal{}, err
	}

	switch p.cur.kind {
	case tkEq:
		p.advance()
		right, err := p.parseAtom()
		if err != nil {
			return exprVal{}, err
		}
		if left.null && right.null {
			return exprVal{s: "true"}, nil
		}
		if left.null || right.null {
			return exprVal{null: true}, nil
		}
		if left.s == right.s {
			return exprVal{s: "true"}, nil
		}
		return exprVal{null: true}, nil

	case tkNeq:
		p.advance()
		right, err := p.parseAtom()
		if err != nil {
			return exprVal{}, err
		}
		if left.null && right.null {
			return exprVal{null: true}, nil
		}
		if left.null || right.null {
			return exprVal{s: "true"}, nil
		}
		if left.s != right.s {
			return exprVal{s: "true"}, nil
		}
		return exprVal{null: true}, nil

	case tkMatch:
		p.advance()
		right, err := p.parseAtom()
		if err != nil {
			return exprVal{}, err
		}
		return doMatch(left, right, false)

	case tkNotMatch:
		p.advance()
		right, err := p.parseAtom()
		if err != nil {
			return exprVal{}, err
		}
		return doMatch(left, right, true)
	}

	return left, nil
}

// stripRegexDelimiters converts "/pattern/" or "/pattern/i" to a Go regexp string.
// When the value comes from a quoted string like "/.*foo.*/" rather than a /…/ literal,
// the lexer produces a tkStr that still carries the delimiters.
func stripRegexDelimiters(s string) string {
	if !strings.HasPrefix(s, "/") {
		return s
	}
	last := strings.LastIndex(s[1:], "/")
	if last < 0 {
		return s // no closing delimiter, use as-is
	}
	pattern := s[1 : last+1]
	flags := s[last+2:]
	if strings.Contains(flags, "i") {
		pattern = "(?i)" + pattern
	}
	return pattern
}

func doMatch(left, right exprVal, negate bool) (exprVal, error) {
	if left.null {
		if negate {
			return exprVal{s: "true"}, nil
		}
		return exprVal{null: true}, nil
	}
	pattern := ""
	if !right.null {
		pattern = stripRegexDelimiters(right.s)
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return exprVal{null: true}, fmt.Errorf("invalid regex %q: %w", pattern, err)
	}
	ok := re.MatchString(left.s)
	if negate {
		ok = !ok
	}
	if ok {
		return exprVal{s: "true"}, nil
	}
	return exprVal{null: true}, nil
}

func (p *exprParser) parseAtom() (exprVal, error) {
	t := p.cur
	p.advance()
	switch t.kind {
	case tkVar:
		v, ok := p.env[t.val]
		if !ok || v == "" {
			return exprVal{null: true}, nil
		}
		return exprVal{s: v}, nil
	case tkStr:
		return exprVal{s: t.val}, nil
	case tkNull:
		return exprVal{null: true}, nil
	case tkRegex:
		return exprVal{s: t.val}, nil
	case tkLParen:
		v, err := p.parseOr()
		if err != nil {
			return exprVal{}, err
		}
		if p.cur.kind == tkRParen {
			p.advance()
		}
		return v, nil
	}
	return exprVal{null: true}, nil
}
