---
title: Erwin Schrödinger and Wave Mechanics
aliases:
  - Schrödinger Equation
  - Wave Equation
tags:
  - physics
  - quantum
  - wave-mechanics
created: 2026-01-15
author: Erwin Schrödinger
difficulty: intermediate
---

# Erwin Schrödinger and Wave Mechanics

Erwin Schrödinger formulated the fundamental equation governing the spatial and temporal evolution of a quantum mechanical state vector. In the framework of [[Wave Mechanics|wave mechanics]], physical particles exhibit wave-like probability distributions described by a wave function $\Psi(\mathbf{r}, t)$.

## The Time-Dependent Schrödinger Equation

The general time-dependent formulation expresses how the quantum state changes over continuous time under the Hamiltonian operator:

$$
i\hbar \frac{\partial}{\partial t}\Psi(\mathbf{r},t) = \left[ -\frac{\hbar^2}{2m}\nabla^2 + V(\mathbf{r},t) \right] \Psi(\mathbf{r},t)
$$ ^eq1

Here, $i$ is the imaginary unit, $\hbar$ is the reduced Planck constant, $m$ is the particle mass, $\nabla^2$ is the Laplacian operator, and $V(\mathbf{r},t)$ denotes the external potential field.

> [!note] Fundamental Postulate
> The state of a quantum physical system at any instant $t$ is fully described by the complex probability amplitude $\Psi(\mathbf{r},t)$ belonging to a Hilbert space over [[LinearAlgebra|state space]].

## Probabilistic Interpretation and Normalization

Max Born introduced the statistical interpretation of the wave function:

$$
P(\mathbf{r}, t) = |\Psi(\mathbf{r}, t)|^2 = \Psi^*(\mathbf{r}, t)\Psi(\mathbf{r}, t)
$$

The total probability of finding the particle anywhere in three-dimensional space must equal unity:

$$
\int_{-\infty}^{\infty} |\Psi(\mathbf{r}, t)|^2 \, d^3\mathbf{r} = 1
$$

In the macroscopic correspondence limit, quantum wave mechanics converges to classical trajectory predictions formulated in [[Physics/Classical/Newton|Newtonian mechanics]].
