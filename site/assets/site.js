// The landing page's motion: the bracket in the hero rebuilt from its wall thickness, the dot going round the loop,
// and the sections coming into view. With motion reduced, each is drawn once, in its last state.
;(function () {
  'use strict'
  document.documentElement.classList.add('js')
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var NS = 'http://www.w3.org/2000/svg'

  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name)
    for (var k in attrs) e.setAttribute(k, attrs[k])
    if (parent) parent.appendChild(e)
    return e
  }

  // Seen from +x +y, Z up, millimetres; S pixels to the millimetre.
  var S = 5, CX = 158, CY = 178, C30 = Math.cos(Math.PI / 6), S30 = 0.5
  function P(x, y, z) {
    return [CX + (x - y) * C30 * S, CY + (x + y) * S30 * S - z * S]
  }
  function d(points, close) {
    return points.map(function (p, i) { var q = P(p[0], p[1], p[2]); return (i ? 'L' : 'M') + q[0].toFixed(2) + ' ' + q[1].toFixed(2) }).join('') + (close ? 'Z' : '')
  }

  // An L bracket: a base 24 deep, an upright 26 high, both `t` thick, 36 wide, with two holes in the base.
  var W = 36, D = 24, H = 26, WANT = 3
  function bracket(t) {
    var prof = [[0, 0], [D, 0], [D, t], [t, t], [t, H], [0, H]]
    var at = function (x) { return prof.map(function (p) { return [x, p[0], p[1]] }) }
    var far = at(0), near = at(W)
    var paths = []
    paths.push({ cls: 'face', d: d([[0, t, t], [W, t, t], [W, t, H], [0, t, H]], true) })
    paths.push({ cls: 'face', d: d([[0, t, t], [W, t, t], [W, D, t], [0, D, t]], true) })
    paths.push({ cls: 'hidden', d: d([far[5], far[0], far[1]]) })
    paths.push({ cls: '', d: d([far[1], far[2], far[3], far[4], far[5]]) })
    paths.push({ cls: '', d: d(near, true) })
    for (var i = 1; i < 6; i++) paths.push({ cls: '', d: d([far[i], near[i]]) })
    ;[12, 24].forEach(function (hx) {
      var pts = []
      for (var a = 0; a <= 32; a++) {
        var u = (a / 32) * Math.PI * 2
        pts.push([hx + 3.5 * Math.cos(u), (t + D) / 2 + 2 + 3.5 * Math.sin(u), t])
      }
      paths.push({ cls: 'hole', d: d(pts, true) })
    })
    return paths
  }

  var part = document.getElementById('part')
  if (part) {
    var grid = part.querySelector('.grid'), edges = part.querySelector('.edges')
    for (var g = -12; g <= 48; g += 6) {
      var a1 = P(g, -12, 0), a2 = P(g, 40, 0), b1 = P(-12, g, 0), b2 = P(48, g, 0)
      el('line', { x1: a1[0], y1: a1[1], x2: a2[0], y2: a2[1] }, grid)
      el('line', { x1: b1[0], y1: b1[1], x2: b2[0], y2: b2[1] }, grid)
    }
    var nodes = []
    bracket(2).forEach(function (p, i) {
      var n = el('path', { d: p.d, class: p.cls }, edges)
      if (p.cls === 'hidden') n.setAttribute('opacity', '0.3'), n.setAttribute('stroke-dasharray', '3 4')
      nodes.push(n)
    })
    var dimLine = part.querySelector('.dim-line'), dimText = part.querySelector('.dim-text')
    var stem = part.querySelector('.pin-stem'), head = part.querySelector('.pin-head'), ref = part.querySelector('.pin-ref')
    var wallOut = document.querySelector('[data-wall]'), verdict = document.querySelector('[data-verdict]')

    var render = function (t) {
      var ps = bracket(t)
      for (var i = 0; i < ps.length; i++) nodes[i].setAttribute('d', ps[i].d)
      var l1 = P(W, 0, H + 3), l2 = P(W, t, H + 3)
      dimLine.setAttribute('x1', l1[0]); dimLine.setAttribute('y1', l1[1])
      dimLine.setAttribute('x2', l2[0]); dimLine.setAttribute('y2', l2[1])
      dimText.setAttribute("x", l2[0] - 20); dimText.setAttribute("y", l2[1] - 12)
      dimText.textContent = t.toFixed(3) + ' mm'
      var base = P(W / 2, t, H * 0.62), top = [base[0] + 26, base[1] - 34]
      stem.setAttribute('x1', base[0]); stem.setAttribute('y1', base[1])
      stem.setAttribute('x2', top[0]); stem.setAttribute('y2', top[1])
      head.setAttribute('cx', top[0]); head.setAttribute('cy', top[1])
      ref.setAttribute('x', top[0]); ref.setAttribute('y', top[1])
      wallOut.textContent = t.toFixed(3)
      var ok = t >= WANT - 1e-9
      verdict.textContent = ok ? 'passes' : 'fails'
      verdict.classList.toggle('pass', ok)
    }

    if (still) {
      render(WANT)
      part.classList.add('marked')
    } else {
      render(2)
      nodes.forEach(function (n, i) {
        if (n.classList.contains('face') || n.classList.contains('hidden')) return
        n.style.setProperty('--len', Math.ceil(n.getTotalLength()) + 1)
        n.style.setProperty('--delay', (i * 0.06).toFixed(2) + 's')
      })
      part.classList.add('drawing')
      var visible = true
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting }).observe(part)
      var ease = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2 }
      // 0 to 1.6 s drawn; marks at 2 s; rebuilt 3 to 4.4 s; held; back to 2 mm at 9 s; again from 12 s.
      var start = null, clock = 0, last = null
      var frame = function (now) {
        if (last !== null && visible) clock += Math.min(now - last, 100)
        last = now
        var s = clock / 1000
        if (s > 2.4 && part.classList.contains('drawing')) {
          part.classList.remove('drawing')
          nodes.forEach(function (n) { n.style.removeProperty('--len') })
        }
        if (s > 2) part.classList.add('marked')
        var c = s < 12 ? s : 3 + ((s - 12) % 9)
        var t = 2
        if (c >= 3 && c < 4.4) t = 2 + ease((c - 3) / 1.4)
        else if (c >= 4.4 && c < 9) t = 3
        else if (c >= 9 && c < 9.8) t = 3 - ease((c - 9) / 0.8)
        if (visible) render(t)
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }
  }

  // The loop: four steps on a ring, the dot going round in eight seconds while the ring is in view.
  var ring = document.getElementById('ring')
  if (ring) {
    var R = 120, LAP = 8000, C = 2 * Math.PI * R
    var nodeG = ring.querySelector('.ring-nodes'), dot = ring.querySelector('.ring-dot'), trail = ring.querySelector('.ring-trail')
    var steps = document.querySelectorAll('.steps li')
    var marks = []
    for (var k = 0; k < 4; k++) {
      var ang = -Math.PI / 2 + (k * Math.PI) / 2
      var gk = el('g', {}, nodeG)
      el('circle', { cx: 160 + R * Math.cos(ang), cy: 160 + R * Math.sin(ang), r: 18 }, gk)
      var tx = el('text', { x: 160 + R * Math.cos(ang), y: 160 + R * Math.sin(ang) }, gk)
      tx.textContent = String(k + 1)
      marks.push(gk)
    }
    trail.setAttribute('stroke-dasharray', C.toFixed(1))
    var light = function (on) {
      for (var j = 0; j < 4; j++) {
        marks[j].classList.toggle('on', j === on)
        if (steps[j]) steps[j].classList.toggle('on', j === on)
      }
    }
    if (still) {
      dot.setAttribute('opacity', '0')
      trail.setAttribute('stroke-dashoffset', '0')
    } else {
      var inView = false, t0 = 0, prev = null
      new IntersectionObserver(function (es) { inView = es[0].isIntersecting }, { threshold: 0.3 }).observe(ring)
      var spin = function (now) {
        if (prev !== null && inView) t0 += Math.min(now - prev, 100)
        prev = now
        if (inView) {
          var p = (t0 % LAP) / LAP
          var a = -Math.PI / 2 + p * Math.PI * 2
          dot.setAttribute('cx', (160 + R * Math.cos(a)).toFixed(2))
          dot.setAttribute('cy', (160 + R * Math.sin(a)).toFixed(2))
          trail.setAttribute('stroke-dashoffset', (C * (1 - p)).toFixed(1))
          light(Math.floor(p * 4 + 0.08) % 4)
        }
        requestAnimationFrame(spin)
      }
      requestAnimationFrame(spin)
    }
  }

  // Sections come into view once.
  var reveals = document.querySelectorAll('.reveal')
  if (still || !('IntersectionObserver' in window)) {
    reveals.forEach(function (r) { r.classList.add('seen') })
  } else {
    var ob = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('seen'); ob.unobserve(e.target) } })
    }, { rootMargin: '0px 0px -10% 0px' })
    reveals.forEach(function (r) { ob.observe(r) })
  }
})()
